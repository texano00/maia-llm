import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { buildEstimate, MINIMUM_BILLABLE_MINUTES } from "../../src/main/services/cost/estimator";
import { SessionOrchestrator, SessionError } from "../../src/main/services/sessions/orchestrator";
import { SessionStore } from "../../src/main/services/sessions/store";
import { createMockComputeProvider, createMockInference } from "../../src/main/services/providers/mock-runtime";

const offer = {
  offerId: 7,
  gpuName: "RTX 4090",
  gpuRamGb: 24,
  hourlyRateMicroUsd: 440_000,
  expectedWaitMinutes: 2,
  simulated: true
};

describe("estimate", () => {
  it("prices the expected session and states a minimum charge", () => {
    const estimate = buildEstimate({
      id: "e1",
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      offer,
      expectedMinutes: 30,
      now: new Date("2026-11-03T10:00:00.000Z"),
      simulated: true
    });

    expect(estimate.minimumMinutes).toBe(MINIMUM_BILLABLE_MINUTES);
    expect(estimate.hourlyRateMicroUsd).toBe(440_000);
    expect(estimate.projectedTotalMicroUsd).toBe(220_000);
    expect(estimate.rangeMicroUsd.low).toBe(36_667);
    expect(estimate.rangeMicroUsd.high).toBeGreaterThanOrEqual(estimate.projectedTotalMicroUsd);
    expect(estimate.waitMinutes).toEqual({ low: 0, high: 4 });
    expect(estimate.currency).toBe("USD");
    expect(estimate.assumptions.length).toBeGreaterThan(0);
    expect(estimate.simulated).toBe(true);
  });

  it("never charges less than the minimum window", () => {
    const estimate = buildEstimate({
      id: "e2",
      modelId: "m",
      offer,
      expectedMinutes: 1,
      now: new Date(),
      simulated: false
    });

    expect(estimate.expectedMinutes).toBe(MINIMUM_BILLABLE_MINUTES);
    expect(estimate.projectedTotalMicroUsd).toBe(estimate.rangeMicroUsd.low);
  });
});

describe("SessionOrchestrator", () => {
  let db: DatabaseConnection;
  let store: SessionStore;
  let clock: number;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SessionStore(db);
    clock = Date.parse("2026-11-03T10:00:00.000Z");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function createOrchestrator(options: { idleTimeoutMinutes?: number } = {}) {
    const compute = createMockComputeProvider({ offer });
    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "hello from the mock runtime" }),
      idleTimeoutMinutes: options.idleTimeoutMinutes ?? 10,
      now: () => clock
    });

    return { orchestrator, compute };
  }

  it("refuses to provision without a confirmed estimate", async () => {
    const { orchestrator } = createOrchestrator();
    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");

    await expect(
      orchestrator.start({ estimateId: estimate.id, confirmEstimate: false as unknown as true })
    ).rejects.toBeInstanceOf(SessionError);

    expect(store.getActive()).toHaveLength(0);
  });

  it("rejects an estimate id it never issued", async () => {
    const { orchestrator } = createOrchestrator();

    await expect(
      orchestrator.start({ estimateId: "nope", confirmEstimate: true })
    ).rejects.toMatchObject({ code: "ESTIMATE_REQUIRED" });
  });

  it("provisions, streams, persists state, and releases the GPU", async () => {
    const { orchestrator, compute } = createOrchestrator();
    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");

    const session = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });

    expect(session.state).toBe("active");
    expect(session.instanceId).not.toBeNull();
    expect(store.getActive()).toHaveLength(1);

    const chunks: string[] = [];
    const result = await orchestrator.send(session.id, "hi", (delta) => chunks.push(delta));

    expect(result.text).toBe("hello from the mock runtime");
    expect(chunks.join("")).toBe("hello from the mock runtime");
    expect(result.tokens).toBeGreaterThan(0);

    const ended = await orchestrator.end(session.id, "user");

    expect(ended?.state).toBe("ended");
    expect(ended?.endReason).toBe("user");
    expect(compute.destroyed).toEqual([session.instanceId]);
    expect(store.getActive()).toHaveLength(0);
    expect(orchestrator.getStatus()).toBeNull();
  });

  it("refuses a second concurrent session", async () => {
    const { orchestrator } = createOrchestrator();
    const first = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    await orchestrator.start({ estimateId: first.id, confirmEstimate: true });

    const second = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");

    await expect(orchestrator.start({ estimateId: second.id, confirmEstimate: true })).rejects.toMatchObject(
      { code: "SESSION_CONFLICT" }
    );
  });

  it("releases the GPU when the session idles past the configured window", async () => {
    const { orchestrator, compute } = createOrchestrator({ idleTimeoutMinutes: 10 });
    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const session = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });

    clock += 5 * 60_000;
    await expect(orchestrator.reapIdle()).resolves.toBeNull();

    clock += 6 * 60_000;
    const ended = await orchestrator.reapIdle();

    expect(ended?.endReason).toBe("idle");
    expect(compute.destroyed).toEqual([session.instanceId]);
  });

  it("keeps the session alive while chat activity continues", async () => {
    const { orchestrator } = createOrchestrator({ idleTimeoutMinutes: 10 });
    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const session = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });

    clock += 9 * 60_000;
    await orchestrator.send(session.id, "still here", () => undefined);
    clock += 9 * 60_000;

    await expect(orchestrator.reapIdle()).resolves.toBeNull();
  });

  it("reconciles instances left behind by a crash", async () => {
    const { orchestrator } = createOrchestrator();
    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const session = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });

    // Simulate a new process starting with an active row already in the database.
    const restartedCompute = createMockComputeProvider({ offer });
    const restarted = new SessionOrchestrator({
      store,
      compute: restartedCompute,
      inference: createMockInference(),
      idleTimeoutMinutes: 10,
      now: () => clock
    });

    const reconciled = await restarted.reconcile();

    expect(reconciled).toBe(1);
    expect(restartedCompute.destroyed).toContain(session.instanceId);
    expect(store.getActive()).toHaveLength(0);
  });
});
