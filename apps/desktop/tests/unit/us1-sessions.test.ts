import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { buildEstimate, MINIMUM_BILLABLE_MINUTES } from "../../src/main/services/cost/estimator";
import { SessionOrchestrator, SessionError, type ComputeOffer, type ComputeProvider } from "../../src/main/services/sessions/orchestrator";
import { isOfferUnavailableError } from "../../src/main/services/providers/vastai/client";
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
    const result = await orchestrator.send(session.id, "hi", (kind, delta) => {
      if (kind === "content") {
        chunks.push(delta);
      }
    });

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

  it("runs several sessions in parallel, one per model conversation", async () => {
    const { orchestrator } = createOrchestrator();
    const first = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const firstSession = await orchestrator.start({ estimateId: first.id, confirmEstimate: true });

    const second = await orchestrator.createEstimate("mistralai/Mistral-7B-Instruct-v0.3");
    const secondSession = await orchestrator.start({ estimateId: second.id, confirmEstimate: true });

    expect(orchestrator.listSessions()).toHaveLength(2);
    expect(orchestrator.findSessionForModel("mistralai/Mistral-7B-Instruct-v0.3")?.id).toBe(
      secondSession.id
    );

    await orchestrator.end(firstSession.id, "user");

    expect(orchestrator.listSessions()).toHaveLength(1);
    expect(orchestrator.getSession(secondSession.id)?.state).toBe("active");
  });

  it("moves to the next GPU when the chosen offer is taken before booking", async () => {
    const taken: ComputeOffer = {
      offerId: 11,
      gpuName: "RTX 4090",
      gpuRamGb: 24,
      hourlyRateMicroUsd: 440_000,
      expectedWaitMinutes: 2,
      simulated: false
    };
    const alternative: ComputeOffer = { ...taken, offerId: 12, gpuName: "L40S", hourlyRateMicroUsd: 610_000 };
    const searches: number[][] = [];

    const compute: ComputeProvider = {
      async findOffer({ excludeOfferIds }) {
        searches.push(excludeOfferIds ?? []);
        const excluded = new Set(excludeOfferIds ?? []);
        return excluded.has(taken.offerId) ? alternative : taken;
      },
      async createInstance(offer) {
        if (offer.offerId === taken.offerId) {
          // Exactly what vast.ai answers when the machine was rented meanwhile.
          throw new Error(
            "PUT /api/v0/asks/11/ failed with status 400: invalid_args — error 404/3603: no_such_ask  Instance type by id 11 is not available."
          );
        }

        return { instanceId: 555 };
      },
      async waitUntilReady() {
        return undefined;
      },
      async destroyInstance() {
        return undefined;
      },
      isOfferUnavailable: isOfferUnavailableError
    };

    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "ok" }),
      idleTimeoutMinutes: 10,
      now: () => clock
    });

    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const session = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });

    expect(session.state).toBe("active");
    expect(session.gpuName).toBe("L40S");
    expect(session.instanceId).toBe(555);
    // estimate search, start search, then one retry that excludes the taken offer
    expect(searches).toEqual([[], [], [11]]);

    const messages = store.eventsFor(session.id).map((event) => event.message);
    expect(messages.some((message) => message.includes("was taken before it could be booked"))).toBe(true);
    expect(messages.some((message) => message.includes("Trying L40S"))).toBe(true);
  });

  it("respects the GPU filters when ranking offers", async () => {
    const filtered = createMockComputeProvider();
    const offer = await filtered.findOffer({
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      filters: { countries: ["US"], datacenters: [], minReliability: null, maxHourlyMicroUsd: null }
    });

    expect(offer?.gpuName).toBe("Mock L40S");

    const none = await filtered.findOffer({
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      filters: {
        countries: ["JP"],
        datacenters: [],
        minReliability: null,
        maxHourlyMicroUsd: null
      }
    });

    expect(none).toBeNull();
  });

  it("releases the GPU when the session idles past the configured window", async () => {
    const { orchestrator, compute } = createOrchestrator({ idleTimeoutMinutes: 10 });
    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const session = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });

    clock += 5 * 60_000;
    await expect(orchestrator.reapIdle()).resolves.toHaveLength(0);

    clock += 6 * 60_000;
    const [ended] = await orchestrator.reapIdle();

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

    await expect(orchestrator.reapIdle()).resolves.toHaveLength(0);
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
