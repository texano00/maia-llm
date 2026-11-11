import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { SessionStore } from "../../src/main/services/sessions/store";
import {
  SessionOrchestrator,
  type ComputeOffer,
  type ComputeProvider
} from "../../src/main/services/sessions/orchestrator";
import { createMockComputeProvider, createMockInference } from "../../src/main/services/providers/mock-runtime";
import { describeRun } from "../../src/renderer/features/models/run-details";
import { toVisibleStatus } from "../../src/renderer/features/models/status";

const offer: ComputeOffer = {
  offerId: 7,
  gpuName: "RTX 4090",
  gpuRamGb: 24,
  hourlyRateMicroUsd: 440_000,
  expectedWaitMinutes: 2,
  simulated: true
};

describe("model run lifecycle", () => {
  let db: DatabaseConnection;
  let store: SessionStore;
  let clock: number;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SessionStore(db);
    clock = Date.parse("2026-11-11T10:00:00.000Z");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function createOrchestrator(): SessionOrchestrator {
    const compute = createMockComputeProvider({ offer, provisionDelayMs: 5 }) as ComputeProvider;
    return new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "hello from the mock runtime" }),
      idleTimeoutMinutes: 10,
      now: () => clock
    });
  }

  it("shows one run with a single permitted status at every lifecycle stage", async () => {
    const orchestrator = createOrchestrator();
    const estimate = await orchestrator.createEstimate("Qwen/Qwen2.5-7B-Instruct");
    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });

    // Initializing: the row exists but the model is not serving yet.
    const provisioning = orchestrator.getSession(started.id);
    expect(provisioning?.state).toBe("provisioning");
    expect(toVisibleStatus(provisioning!.state)).toBe("initializing");
    expect(describeRun(provisioning!, { now: clock }).valuesPending).toBe(true);
    expect(orchestrator.listSessionHistory()).toHaveLength(0);

    // Running: the runtime answers and the run stays out of the history read.
    await orchestrator.awaitProvisioning(started.id);
    const active = orchestrator.getSession(started.id);
    expect(toVisibleStatus(active!.state)).toBe("running");
    expect(orchestrator.listSessionHistory()).toHaveLength(0);

    // Terminated: the row survives in the history query with its final details.
    clock += 30 * 60_000;
    await orchestrator.end(started.id, "user");

    const history = orchestrator.listSessionHistory();
    expect(history).toHaveLength(1);
    const [run] = history;
    expect(run?.id).toBe(started.id);
    expect(toVisibleStatus(run!.state)).toBe("terminated");

    const details = describeRun(run!, { now: clock });
    expect(details.endDetailsPending).toBe(false);
    expect(details.durationMs).toBe(30 * 60_000);
    expect(details.endTime).toBe(new Date(clock).toISOString());

    // Each run is one entry: it left the active list when it ended.
    expect(orchestrator.listSessions().map((session) => session.id)).not.toContain(started.id);
  });

  it("keeps a run that failed to initialize in the history", () => {
    const orchestrator = createOrchestrator();

    store.insert({
      id: "failed-run",
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      state: "provisioning",
      runtime: "vllm",
      label: "maia:failed-run",
      gpuName: "RTX 4090",
      gpuRamGb: 24,
      hourlyRateMicroUsd: 440_000,
      estimatedTotalMicroUsd: 220_000,
      startedAt: new Date(clock).toISOString(),
      containerImage: "vllm/vllm-openai:latest"
    });
    store.transition("failed-run", "failed", {
      endedAt: new Date(clock + 120_000).toISOString(),
      endReason: "failure",
      failureCode: "INTERNAL"
    });
    store.appendEvent("failed-run", "error", "Engine core initialization failed");

    const [run] = orchestrator.listSessionHistory();
    expect(run?.id).toBe("failed-run");
    expect(toVisibleStatus(run!.state)).toBe("terminated");
    expect(run?.endReason).toBe("failure");
    expect(describeRun(run!, { now: clock }).endReasonLabel).toBe("Failed");
    expect(orchestrator.listSessions()).toHaveLength(0);
  });
});
