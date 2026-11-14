import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { seedAccount } from "../helpers/accounts";
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
    seedAccount(db);
    store = new SessionStore(db, "account-test");
    clock = Date.parse("2026-11-03T10:00:00.000Z");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function createOrchestrator(
    options: { idleTimeoutMinutes?: number; provisionDelayMs?: number } = {}
  ) {
    const compute = createMockComputeProvider({
      offer,
      ...(options.provisionDelayMs === undefined ? {} : { provisionDelayMs: options.provisionDelayMs })
    });
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

  it("requires explicit access confirmation before starting a gated model", async () => {
    const compute = createMockComputeProvider({ offer });
    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "" }),
      idleTimeoutMinutes: 10,
      now: () => clock,
      isGatedModel: () => true
    });
    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");

    await expect(
      orchestrator.start({ estimateId: estimate.id, confirmEstimate: true })
    ).rejects.toMatchObject({ code: "GATED_ACCESS_REQUIRED" });
    expect(store.getActive()).toHaveLength(0);

    const started = await orchestrator.start({
      estimateId: estimate.id,
      confirmEstimate: true,
      confirmGatedAccess: true
    });
    await orchestrator.awaitProvisioning(started.id);
    expect(orchestrator.getSession(started.id)?.state).toBe("active");
    await orchestrator.end(started.id, "user");
  });

  it("refuses a model the runtime cannot serve before renting anything", async () => {
    const compute = createMockComputeProvider({ offer });
    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "" }),
      idleTimeoutMinutes: 10,
      now: () => clock,
      assertRunnable: (modelId) => {
        if (modelId === "BAAI/bge-small-en-v1.5") {
          throw new Error(`"${modelId}" is a sentence-similarity model, not a chat model.`);
        }
      }
    });

    // Refused at the estimate: no offer search, no booking, no boot.
    await expect(orchestrator.createEstimate("BAAI/bge-small-en-v1.5")).rejects.toThrow(
      /not a chat model/
    );

    // Nothing was booked, so nothing can bill.
    expect(store.getActive()).toHaveLength(0);
    expect(orchestrator.listSessions()).toHaveLength(0);
  });

  it("provisions, streams, persists state, and releases the GPU", async () => {
    const { orchestrator, compute } = createOrchestrator();
    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");

    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });

    // Booking returns as soon as the instance exists; the boot continues in the
    // background so other models can be started meanwhile.
    expect(started.state).toBe("provisioning");

    await orchestrator.awaitProvisioning(started.id);
    const session = orchestrator.getSession(started.id);

    expect(session?.state).toBe("active");
    expect(session?.instanceId).not.toBeNull();
    expect(store.getActive()).toHaveLength(1);

    const chunks: string[] = [];
    const result = await orchestrator.send(session!.id, "hi", (kind, delta) => {
      if (kind === "content") {
        chunks.push(delta);
      }
    });

    expect(result.text).toBe("hello from the mock runtime");
    expect(chunks.join("")).toBe("hello from the mock runtime");
    expect(result.tokens).toBeGreaterThan(0);

    const ended = await orchestrator.end(session!.id, "user");

    expect(ended?.state).toBe("ended");
    expect(ended?.endReason).toBe("user");
    expect(compute.destroyed).toEqual([session!.instanceId]);
    expect(store.getActive()).toHaveLength(0);
    expect(orchestrator.getStatus()).toBeNull();
  });

  it("boots two models at the same time", async () => {
    const { orchestrator } = createOrchestrator({ provisionDelayMs: 40 });

    const firstEstimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const first = await orchestrator.start({ estimateId: firstEstimate.id, confirmEstimate: true });

    const secondEstimate = await orchestrator.createEstimate("mistralai/Mistral-7B-Instruct-v0.3");
    const second = await orchestrator.start({ estimateId: secondEstimate.id, confirmEstimate: true });

    // Neither call waited for the model to load, so both are provisioning.
    expect(first.state).toBe("provisioning");
    expect(second.state).toBe("provisioning");
    expect(orchestrator.listSessions().filter((entry) => entry.state === "provisioning")).toHaveLength(2);

    await Promise.all([
      orchestrator.awaitProvisioning(first.id),
      orchestrator.awaitProvisioning(second.id)
    ]);

    expect(orchestrator.getSession(first.id)?.state).toBe("active");
    expect(orchestrator.getSession(second.id)?.state).toBe("active");
    expect(store.getActive()).toHaveLength(2);
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
      delay: async () => undefined,
      now: () => clock
    });

    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(started.id);
    const session = orchestrator.getSession(started.id);

    expect(session?.state).toBe("active");
    expect(session?.gpuName).toBe("L40S");
    expect(session?.instanceId).toBe(555);
    // estimate search, start search, then one retry that excludes the taken offer
    expect(searches).toEqual([[], [], [11]]);

    const messages = store.eventsFor(started.id).map((event) => event.message);
    expect(messages.some((message) => message.includes("could not be booked"))).toBe(true);
    expect(messages.some((message) => message.includes("Trying L40S"))).toBe(true);
  });

  it("keeps a failed boot visible with its log, and lets the model be retried", async () => {
    let failNext = true;
    const destroyed: number[] = [];

    const compute: ComputeProvider = {
      async findOffer() {
        return offer;
      },
      async createInstance() {
        return { instanceId: 900 };
      },
      async waitUntilReady() {
        if (failNext) {
          throw new Error("The GPU instance stopped while starting up (error).");
        }
      },
      async destroyInstance(instanceId) {
        destroyed.push(instanceId);
      }
    };

    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "ok" }),
      idleTimeoutMinutes: 10,
      delay: async () => undefined,
      now: () => clock
    });

    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(started.id);

    const failed = orchestrator.getSession(started.id);
    expect(failed?.state).toBe("failed");
    expect(
      failed?.events.some(
        (event) => event.level === "error" && event.message.includes("stopped while starting up")
      )
    ).toBe(true);
    // The log stays readable, but the model is not offered as a usable session.
    expect(orchestrator.listSessions().map((session) => session.id)).toContain(started.id);
    expect(orchestrator.findSessionForModel("Qwen/Qwen2.5-7B-Instruct")).toBeNull();
    expect(destroyed).toEqual([900]);

    failNext = false;
    const retryEstimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const retried = await orchestrator.start({ estimateId: retryEstimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(retried.id);

    expect(orchestrator.getSession(retried.id)?.state).toBe("active");
    expect(orchestrator.listSessions().map((session) => session.id)).not.toContain(started.id);
  });

  it("says plainly when every offer is taken before it can be booked", async () => {
    let searches = 0;
    const compute: ComputeProvider = {
      async findOffer() {
        searches += 1;
        return { ...offer, offerId: 100 + searches, simulated: false };
      },
      async createInstance(candidate) {
        throw new Error(
          `PUT /api/v0/asks/${candidate.offerId}/ failed with status 400: invalid_args — error 404/3603: no_such_ask  Instance type by id ${candidate.offerId} is not available.`
        );
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
      delay: async () => undefined,
      now: () => clock
    });

    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");

    await expect(
      orchestrator.start({ estimateId: estimate.id, confirmEstimate: true })
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      message: expect.stringContaining("taken before it could be booked")
    });

    // The estimate search, the start search, then one search per retry.
    expect(searches).toBe(7);
    expect(store.getActive()).toHaveLength(0);
  });

  it("retries any booking failure on the next GPU, not only vanished offers", async () => {
    let attempts = 0;
    const compute: ComputeProvider = {
      async findOffer({ excludeOfferIds }) {
        const excluded = new Set(excludeOfferIds ?? []);
        return { ...offer, offerId: excluded.size === 0 ? 21 : 22, simulated: false };
      },
      async createInstance(candidate) {
        attempts += 1;
        if (candidate.offerId === 21) {
          // A transient provider hiccup that is not an offer-gone error.
          throw new Error("PUT /api/v0/asks/21/ failed with status 502 (Provider request failed)");
        }

        return { instanceId: 777 };
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
      delay: async () => undefined,
      now: () => clock
    });

    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(started.id);

    expect(attempts).toBe(2);
    expect(orchestrator.getSession(started.id)?.state).toBe("active");
    expect(orchestrator.getSession(started.id)?.instanceId).toBe(777);
  });

  it("logs every provisioning stage so a slow boot is visible", async () => {
    const compute: ComputeProvider = {
      async findOffer() {
        return offer;
      },
      async createInstance() {
        return { instanceId: 4242 };
      },
      async waitUntilReady(_instanceId, _timeoutMs, onProgress) {
        onProgress?.({ status: "scheduling", message: null, elapsedMs: 2_000 });
        onProgress?.({ status: "loading", message: "pulling the image", elapsedMs: 61_000 });
        onProgress?.({ status: "running", message: null, elapsedMs: 121_000 });
      },
      async destroyInstance() {
        return undefined;
      }
    };

    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "ok" }),
      idleTimeoutMinutes: 10,
      delay: async () => undefined,
      now: () => clock
    });

    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(started.id);

    const messages = store.eventsFor(started.id).map((event) => event.message);

    expect(messages.some((message) => message.includes("Waiting for the host to allocate"))).toBe(true);
    expect(messages.some((message) => message.includes("pulling the image"))).toBe(true);
    expect(messages.some((message) => message.includes("2 m 01 s"))).toBe(true);
    expect(messages.some((message) => message.includes("Model server is healthy after"))).toBe(true);
  });

  it("releases instances the app lost track of, so nothing keeps billing", async () => {
    const destroyed: number[] = [];
    const compute: ComputeProvider = {
      async findOffer() {
        return offer;
      },
      async createInstance() {
        return { instanceId: 1 };
      },
      async waitUntilReady() {
        return undefined;
      },
      async destroyInstance(instanceId) {
        destroyed.push(instanceId);
      },
      async listLabelledInstances() {
        return [
          { instanceId: 55, label: "maia:session-that-failed" },
          { instanceId: 66, label: "maia:some-other-run" }
        ];
      }
    };

    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "ok" }),
      idleTimeoutMinutes: 10,
      delay: async () => undefined,
      now: () => clock
    });

    const reconciled = await orchestrator.reconcile();

    expect(destroyed.sort()).toEqual([55, 66]);
    expect(reconciled).toBe(2);
  });

  it("abandons a host that cannot start the container and marks it unstable", async () => {
    const reports: Array<{ machineId: number | null; outcome: string }> = [];
    const booked: number[] = [];
    const bootedOn: number[] = [];

    const compute: ComputeProvider = {
      async findOffer({ excludeMachineIds }) {
        // The bad host is cheapest, so it wins until it has been excluded.
        if ((excludeMachineIds ?? []).includes(5001)) {
          return { ...offer, offerId: 22, machineId: 5002, gpuName: "L40S", simulated: false };
        }
        return { ...offer, offerId: 21, machineId: 5001, gpuName: "RTX 3090", simulated: false };
      },
      async createInstance(candidate) {
        booked.push(candidate.machineId ?? 0);
        return { instanceId: 100 + booked.length };
      },
      async waitUntilReady(instanceId) {
        bootedOn.push(instanceId);
        if (instanceId === 101) {
          // Exactly the failure reported by vast.ai for a broken CDI setup.
          throw new Error(
            "The container could not start on this machine: Error response from daemon: failed to inject CDI devices: unresolvable CDI devices D.759…/gpu=1: unknown"
          );
        }
      },
      async destroyInstance() {
        return undefined;
      },
      isUnrecoverable(error) {
        return error instanceof Error && error.message.includes("could not start");
      },
      async reportOutcome(input) {
        reports.push({ machineId: input.machineId, outcome: input.outcome });
      }
    };

    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "ok" }),
      idleTimeoutMinutes: 10,
      delay: async () => undefined,
      now: () => clock
    });

    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(started.id);

    const session = orchestrator.getSession(started.id);

    expect(session?.state).toBe("active");
    // Second machine, second instance, and the bad host was published as unstable.
    expect(booked).toEqual([5001, 5002]);
    expect(bootedOn).toEqual([101, 102]);
    expect(session?.instanceId).toBe(102);
    expect(reports).toEqual([
      { machineId: 5001, outcome: "failure" },
      { machineId: 5002, outcome: "success" }
    ]);

    const log = store.eventsFor(started.id).map((event) => event.message).join("\n");
    expect(log).toContain(
      "startup failed on machine 5001 (attempt 1 of 6): The container could not start on this machine: Error response from daemon: failed to inject CDI devices"
    );
    expect(log).toContain("Marking machine 5001 as unstable");
    expect(log).toContain("trying another GPU");
    expect(log).toContain("Retrying on L40S");
  });

  it("uses the configured GPU startup retries", async () => {
    const attempts: number[] = [];
    const compute: ComputeProvider = {
      async findOffer({ excludeMachineIds }) {
        const machineId = 8000 + (excludeMachineIds ?? []).length;
        return {
          ...offer,
          offerId: machineId,
          machineId,
          simulated: false
        };
      },
      async createInstance(candidate) {
        return { instanceId: candidate.offerId };
      },
      async waitUntilReady(instanceId) {
        attempts.push(instanceId);
        if (attempts.length <= 2) {
          throw new Error("container startup failed");
        }
      },
      async destroyInstance() {
        return undefined;
      },
      isUnrecoverable: () => true
    };

    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "ok" }),
      idleTimeoutMinutes: 10,
      startupRetries: () => 1,
      delay: async () => undefined,
      now: () => clock
    });

    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(started.id);

    expect(attempts).toHaveLength(2);
    expect(orchestrator.getSession(started.id)?.state).toBe("failed");
  });

  it("retries a host that never reports in, without blacklisting it", async () => {
    const reports: Array<{ machineId: number | null; outcome: string }> = [];
    const booked: number[] = [];

    const compute: ComputeProvider = {
      async findOffer({ excludeMachineIds }) {
        if ((excludeMachineIds ?? []).includes(9001)) {
          return { ...offer, offerId: 52, machineId: 9002, gpuName: "L40S", simulated: false };
        }
        return { ...offer, offerId: 51, machineId: 9001, gpuName: "RTX 3090", simulated: false };
      },
      async createInstance(candidate) {
        booked.push(candidate.machineId ?? 0);
        return { instanceId: 900 + booked.length };
      },
      async waitUntilReady(instanceId) {
        if (instanceId === 901) {
          throw new Error("The GPU instance never became visible (unknown).");
        }
      },
      async destroyInstance() {
        return undefined;
      },
      // A timeout is not a verdict worth sharing, only a reason to move on.
      isUnrecoverable: () => false,
      isRetryableStartup: (error) =>
        error instanceof Error && error.message.includes("never became visible"),
      async reportOutcome(input) {
        reports.push({ machineId: input.machineId, outcome: input.outcome });
      }
    };

    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "ok" }),
      idleTimeoutMinutes: 10,
      delay: async () => undefined,
      now: () => clock
    });

    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(started.id);

    expect(orchestrator.getSession(started.id)?.state).toBe("active");
    expect(booked).toEqual([9001, 9002]);
    // Nothing was published as a failure: the host may be fine for someone else.
    expect(reports).toEqual([{ machineId: 9002, outcome: "success" }]);

    const log = store.eventsFor(started.id).map((event) => event.message).join("\n");
    expect(log).toContain(
      "startup failed on machine 9001 (attempt 1 of 6): The GPU instance never became visible (unknown)."
    );
    expect(log).toContain("did not come up (The GPU instance never became visible (unknown).)");
    expect(log).toContain("Retrying on L40S");
    // Only terminal container failures are labelled unstable.
    expect(log).not.toContain("as unstable");
  });

  it("uses the whole default retry budget when offers keep coming", async () => {
    const attempts: number[] = [];
    let machine = 7000;
    const compute: ComputeProvider = {
      async findOffer({ excludeMachineIds }) {
        // Like vast.ai: always another machine while any remain.
        while ((excludeMachineIds ?? []).includes(machine)) {
          machine += 1;
        }
        return { ...offer, offerId: machine, machineId: machine, simulated: false };
      },
      async createInstance(candidate) {
        return { instanceId: 500 + (candidate.offerId ?? 0) };
      },
      async waitUntilReady(instanceId) {
        attempts.push(instanceId);
        throw new Error("The GPU instance never became visible (unknown).");
      },
      async destroyInstance() {
        return undefined;
      },
      // A host problem: every failure is worth another machine.
      isRetryableStartup: () => true
    };

    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "ok" }),
      idleTimeoutMinutes: 10,
      delay: async () => undefined,
      now: () => clock
    });

    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(started.id);

    // Default `gpuStartupRetries` is 5: the first machine plus five retries.
    expect(attempts).toHaveLength(6);
    expect(orchestrator.getSession(started.id)?.state).toBe("failed");
    expect(store.eventsFor(started.id).map((event) => event.message).join("\n")).toContain(
      "Gave up after 6 of 6 GPU attempts"
    );
  });

  it("says when the retry budget stopped because no GPU was left", async () => {
    const attempts: number[] = [];
    const compute: ComputeProvider = {
      async findOffer({ excludeMachineIds }) {
        if ((excludeMachineIds ?? []).length >= 2) {
          return null;
        }
        const machineId = 8000 + (excludeMachineIds ?? []).length;
        return { ...offer, offerId: machineId, machineId, simulated: false };
      },
      async createInstance(candidate) {
        return { instanceId: 600 + (candidate.offerId ?? 0) };
      },
      async waitUntilReady(instanceId) {
        attempts.push(instanceId);
        throw new Error("The GPU instance never became visible (unknown).");
      },
      async destroyInstance() {
        return undefined;
      },
      isRetryableStartup: () => true
    };

    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "ok" }),
      idleTimeoutMinutes: 10,
      delay: async () => undefined,
      now: () => clock
    });

    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(started.id);

    expect(attempts).toHaveLength(2);
    const log = store.eventsFor(started.id).map((event) => event.message).join("\n");
    expect(log).toContain("No other GPU could be booked");
    expect(log).toContain("Gave up after 2 of 6 GPU attempts");
  });

  it("does not retry a model that vLLM cannot load", async () => {
    const attempts: number[] = [];
    const compute: ComputeProvider = {
      async findOffer() {
        return { ...offer, offerId: 61, machineId: 9101, simulated: false };
      },
      async createInstance() {
        return { instanceId: 401 };
      },
      async waitUntilReady(instanceId) {
        attempts.push(instanceId);
        throw new Error("The GPU instance stopped while starting up (exited).");
      },
      async destroyInstance() {
        return undefined;
      },
      async getInstanceLogs() {
        // The exact traceback from the field for Comfy-Org/MiniMax-H3.
        return [
          "pydantic_core._pydantic_core.ValidationError: 1 validation error for ModelConfig",
          "Value error, Invalid repository ID or local directory specified: 'Comfy-Org/MiniMax-H3'.",
          "- For Hugging Face models: ensure the presence of a 'config.json'.",
          ""
        ].join("\n");
      },
      isUnrecoverable: () => false,
      // Even when the host failure alone looks retryable, the log wins.
      isRetryableStartup: () => true
    };

    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "ok" }),
      idleTimeoutMinutes: 10,
      delay: async () => undefined,
      now: () => clock
    });

    const estimate = await orchestrator.createEstimate("Comfy-Org/MiniMax-H3");
    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(started.id);

    expect(attempts).toHaveLength(1);
    expect(orchestrator.getSession(started.id)?.state).toBe("failed");

    const log = store.eventsFor(started.id).map((event) => event.message).join("\n");
    expect(log).toContain("This is a model problem, not a GPU problem");
    expect(log).toContain("no config.json");
    expect(log).toContain("This model cannot be served");
    expect(log).not.toContain("trying another GPU");
  });

  it("attaches the container log to a failed provisioning attempt", async () => {
    const warnings: Array<Record<string, unknown> | undefined> = [];

    const compute: ComputeProvider = {
      async findOffer() {
        return { ...offer, offerId: 41, machineId: 7001, simulated: false };
      },
      async createInstance() {
        return { instanceId: 301 };
      },
      async waitUntilReady() {
        throw new Error(
          "Timed out waiting for the GPU instance to start (40 min). The GPU was released."
        );
      },
      async destroyInstance() {
        return undefined;
      },
      async getInstanceLogs(instanceId) {
        expect(instanceId).toBe(301);
        return [
          "INFO 07-11 vllm.model_executor: loading weights",
          "ValueError: no safetensors weights found in huihui-ai/model-GGUF",
          ""
        ].join("\n");
      }
    };

    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "ok" }),
      idleTimeoutMinutes: 10,
      delay: async () => undefined,
      now: () => clock,
      logger: {
        info: () => undefined,
        warn: (message, context) => {
          if (message === "Provisioning attempt failed") {
            warnings.push(context);
          }
        }
      }
    });

    const estimate = await orchestrator.createEstimate("huihui-ai/model-GGUF");
    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(started.id);

    // "The port never opened" on its own is not a diagnosis; the container log is.
    expect(warnings[0]).toMatchObject({ instanceId: 301 });
    expect(String(warnings[0]?.remoteLogs)).toContain("no safetensors weights found");

    const log = store.eventsFor(started.id).map((event) => event.message).join("\n");
    expect(log).toMatch(/Container log: .*no safetensors weights found/);
  });

  it("gives up after the boot budget instead of renting machines forever", async () => {
    const compute: ComputeProvider = {
      async findOffer() {
        return { ...offer, offerId: 31 + Math.floor(Math.random() * 1000), machineId: 6001, simulated: false };
      },
      async createInstance() {
        return { instanceId: 200 + Math.floor(Math.random() * 1000) };
      },
      async waitUntilReady() {
        throw new Error("The container could not start on this machine: OCI runtime create failed");
      },
      async destroyInstance() {
        return undefined;
      },
      isUnrecoverable() {
        return true;
      }
    };

    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "ok" }),
      idleTimeoutMinutes: 10,
      delay: async () => undefined,
      now: () => clock
    });

    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(started.id);

    expect(orchestrator.getSession(started.id)?.state).toBe("failed");
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
    await orchestrator.awaitProvisioning(session.id);

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
    await orchestrator.awaitProvisioning(session.id);

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
      delay: async () => undefined,
      now: () => clock
    });

    const reconciled = await restarted.reconcile();

    expect(reconciled).toBe(1);
    expect(restartedCompute.destroyed).toContain(session.instanceId);
    expect(store.getActive()).toHaveLength(0);
  });
});
