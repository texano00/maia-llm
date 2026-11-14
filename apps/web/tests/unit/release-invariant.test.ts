import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { seedAccount } from "../helpers/accounts";
import {
  SessionOrchestrator,
  type ComputeProvider
} from "../../src/main/services/sessions/orchestrator";
import { SessionStore } from "../../src/main/services/sessions/store";
import {
  createMockComputeProvider,
  createMockInference
} from "../../src/main/services/providers/mock-runtime";

const MODEL_ID = "Qwen/Qwen2.5-7B-Instruct";
const OFFER = {
  offerId: 7,
  gpuName: "RTX 4090",
  gpuRamGb: 24,
  hourlyRateMicroUsd: 440_000,
  expectedWaitMinutes: 2,
  simulated: false
};

/**
 * The one promise this product cannot break: a run may only say "ended" when the
 * machine is no longer billing.
 *
 * Reported failure: a session showed "terminated" on the product's side while the
 * GPU kept running on vast.ai. The cause was a teardown that failed (a rate limit
 * during a deploy) and a record that was closed anyway.
 */
describe("releasing a GPU", () => {
  let db: DatabaseConnection;
  let store: SessionStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedAccount(db);
    store = new SessionStore(db, "account-test");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function orchestratorWith(compute: ComputeProvider): SessionOrchestrator {
    return new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "ok" }),
      idleTimeoutMinutes: 10
    });
  }

  async function started(orchestrator: SessionOrchestrator) {
    const estimate = await orchestrator.createEstimate(MODEL_ID);
    return orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
  }

  it("refuses to close the run when the provider may still be billing", async () => {
    const compute = createMockComputeProvider({ offer: OFFER });
    // Teardown fails and the machine is still there: exactly the reported case.
    compute.destroyInstance = async () => {
      throw new Error("429 API requests too frequent");
    };
    (compute as ComputeProvider).instanceExists = async () => true;

    const orchestrator = orchestratorWith(compute);
    const session = await started(orchestrator);

    await expect(orchestrator.end(session.id, "user")).rejects.toThrow(/could not be confirmed released/i);

    // The record stays open, so the machine stays visible and stoppable.
    expect(store.get(session.id)?.state).toBe("ending");
  });

  it("closes the run when the provider no longer lists the machine", async () => {
    const compute = createMockComputeProvider({ offer: OFFER });
    compute.destroyInstance = async () => {
      throw new Error("429 API requests too frequent");
    };
    // The destroy call failed, but the machine is gone: nothing is billing.
    (compute as ComputeProvider).instanceExists = async () => false;

    const orchestrator = orchestratorWith(compute);
    const session = await started(orchestrator);

    const ended = await orchestrator.end(session.id, "user");
    expect(ended?.state).toBe("ended");
  });

  it("closes the run when the teardown succeeds", async () => {
    const compute = createMockComputeProvider({ offer: OFFER });
    const orchestrator = orchestratorWith(compute);
    const session = await started(orchestrator);

    const ended = await orchestrator.end(session.id, "user");

    expect(ended?.state).toBe("ended");
    expect(ended?.endReason).toBe("user");
  });

  it("keeps an orphan open at boot when its release cannot be confirmed", async () => {
    const compute = createMockComputeProvider({ offer: OFFER });
    compute.destroyInstance = async () => {
      throw new Error("429 API requests too frequent");
    };
    (compute as ComputeProvider).instanceExists = async () => true;
    (compute as ComputeProvider).listLabelledInstances = async () => [];

    const orchestrator = orchestratorWith(compute);
    const session = await started(orchestrator);

    // A new process starts: it knows the row, not the run.
    const restart = orchestratorWith(compute);
    await restart.reconcile();

    expect(store.get(session.id)?.state).not.toBe("ended");
  });
});
