import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { seedAccount } from "../helpers/accounts";
import { SessionOrchestrator } from "../../src/main/services/sessions/orchestrator";
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

describe("restarting a run in place", () => {
  let db: DatabaseConnection;
  let store: SessionStore;
  let clock: number;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedAccount(db);
    store = new SessionStore(db, "account-test");
    clock = Date.parse("2026-11-25T10:00:00.000Z");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function build(options: {
    failCreateFrom?: number;
    failDestroyTimes?: number;
    assertRunnable?: () => void | Promise<void>;
  } = {}) {
    const compute = createMockComputeProvider({
      offer,
      provisionDelayMs: 0,
      ...(options.failCreateFrom === undefined ? {} : { failCreateFrom: options.failCreateFrom }),
      ...(options.failDestroyTimes === undefined ? {} : { failDestroyTimes: options.failDestroyTimes })
    });

    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "hello" }),
      idleTimeoutMinutes: 10,
      now: () => clock,
      contextWindowFor: () => 131_072,
      runtimeLimitsFor: () => ({ estimatedMaxContext: 131_072, concurrencyMax: 4 }),
      ...(options.assertRunnable ? { assertRunnable: options.assertRunnable } : {})
    });

    return { orchestrator, compute };
  }

  async function running(orchestrator: SessionOrchestrator) {
    const estimate = await orchestrator.createEstimate("org/model", 30);
    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(started.id);
    return started.id;
  }

  it("keeps the run, its identity and its meter, and reuses the key", async () => {
    const { orchestrator, compute } = build();
    const sessionId = await running(orchestrator);
    const before = orchestrator.getSession(sessionId);
    const beforeConfig = orchestrator.runtimeConfig(sessionId);

    const result = await orchestrator.restart(sessionId, {
      contextWindow: 65_536,
      maxConcurrentRequests: 2
    });

    expect(result.status).toBe("restarted");
    if (result.status !== "restarted") {
      return;
    }

    expect(result.session.id).toBe(sessionId);
    expect(result.session.startedAt).toBe(before?.startedAt);
    expect(result.config.current).toEqual({ contextWindow: 65_536, maxConcurrentRequests: 2 });
    expect(result.session.restart).toBeNull();
    expect(compute.destroyed).toEqual([before?.instanceId]);
    expect(compute.created).toHaveLength(2);
    expect(store.getRestartHistory(sessionId)[0]?.outcome).toBe("succeeded");
    expect(beforeConfig?.current.contextWindow).toBe(32_768);
  });

  it("refuses a second restart while the first is in flight", async () => {
    const { orchestrator } = build();
    const sessionId = await running(orchestrator);

    const first = orchestrator.restart(sessionId, {
      contextWindow: 40_960,
      maxConcurrentRequests: 1
    });

    await expect(
      orchestrator.restart(sessionId, { contextWindow: 49_152, maxConcurrentRequests: 1 })
    ).rejects.toMatchObject({ code: "SESSION_CONFLICT" });

    await expect(first).resolves.toMatchObject({ status: "restarted" });
    expect(store.getRestartHistory(sessionId).some((row) => row.outcome === "refused")).toBe(true);
  });

  it("offers a fresh run with an estimate when the machine cannot be replaced", async () => {
    const { orchestrator, compute } = build({ failCreateFrom: 2 });
    const sessionId = await running(orchestrator);

    const result = await orchestrator.restart(sessionId, {
      contextWindow: 65_536,
      maxConcurrentRequests: 1
    });

    expect(result.status).toBe("fresh_run_required");
    if (result.status === "fresh_run_required") {
      expect(result.estimate.modelId).toBe("org/model");
    }
    // Only the first boot was ever created; the replacement was refused.
    expect(compute.created).toHaveLength(1);
    expect(compute.destroyed).toHaveLength(1);
  });

  it("reports a failed restart with a reason and keeps the previous values", async () => {
    let calls = 0;
    const { orchestrator } = build({
      failDestroyTimes: 1,
      assertRunnable: () => {
        calls += 1;
        // createEstimate (1) and start (2) must succeed; the fallback estimate
        // created after the failed restart is the one that cannot be priced.
        if (calls > 2) {
          throw new Error("no machine available");
        }
      }
    });
    const sessionId = await running(orchestrator);

    const result = await orchestrator.restart(sessionId, {
      contextWindow: 65_536,
      maxConcurrentRequests: 1
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/teardown|destroy|Mock/i);
      expect(result.config.current.contextWindow).toBe(32_768);
    }
    expect(store.getRestartHistory(sessionId)[0]?.outcome).toBe("failed");
  });
});
