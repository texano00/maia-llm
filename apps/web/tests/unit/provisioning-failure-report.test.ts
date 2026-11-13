import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FailureEvent } from "@maia/contracts";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import {
  SessionOrchestrator,
  type ComputeOffer,
  type ComputeProvider
} from "../../src/main/services/sessions/orchestrator";
import { SessionStore } from "../../src/main/services/sessions/store";
import { createMockInference } from "../../src/main/services/providers/mock-runtime";

const offer: ComputeOffer = {
  offerId: 7,
  gpuName: "A100 PCIE",
  gpuRamGb: 80,
  hourlyRateMicroUsd: 870_000,
  expectedWaitMinutes: 2,
  simulated: true
};

const OOM_LOG = [
  "INFO 11-07 10:34:09 model_runner.py:1010] Loading model weights took 11.84 GB",
  "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 58.00 GiB (GPU 0; 79.25 GiB total capacity)",
  'RuntimeError: Engine core initialization failed. See root cause above. Failed core proc(s): {}'
].join("\n");

describe("provisioning failures", () => {
  let db: DatabaseConnection;
  let store: SessionStore;
  let clock: number;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SessionStore(db);
    clock = Date.parse("2026-11-07T10:30:00.000Z");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("reports the container root cause and shrinks the context on the retry", async () => {
    const contexts: Array<{ label: string; modelId: string; contextScale?: number }> = [];
    const reports: FailureEvent[] = [];
    let created = 0;

    const compute: ComputeProvider = {
      async findOffer() {
        return offer;
      },
      async createInstance(_offer, context) {
        contexts.push(context);
        created += 1;
        return { instanceId: created };
      },
      async waitUntilReady(instanceId) {
        if (instanceId === 1) {
          throw Object.assign(
            new Error('The model container stopped while loading the model (vast.ai reported "exited").'),
            { name: "InstanceStartTimeoutError" }
          );
        }
      },
      async getInstanceLogs() {
        return OOM_LOG;
      },
      async destroyInstance() {
        // The released instance is gone; nothing to assert here.
      },
      isRetryableStartup() {
        return true;
      },
      isUnrecoverable() {
        return false;
      }
    };

    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "ok" }),
      idleTimeoutMinutes: 10,
      now: () => clock,
      startupRetries: () => 1,
      reportFailure: (event) => reports.push(event)
    });

    const estimate = await orchestrator.createEstimate("huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF");
    const session = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(session.id);

    // The retry asked for half the context instead of repeating the crash.
    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.contextScale).toBe(0.5);

    // The engine-core death is recorded with the line that explains it.
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      stage: "provisioning",
      modelId: "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF",
      gpuName: "A100 PCIE",
      attempt: 1,
      attemptsTotal: 2,
      contextScale: 0.5
    });
    expect(reports[0]?.rootCause).toContain("torch.OutOfMemoryError");
    expect(reports[0]?.memoryNote).toMatch(/out of memory/i);
    expect(reports[0]?.logTail).toContain("Engine core initialization failed");

    // The second attempt came up, so the session is usable.
    expect(orchestrator.getSession(session.id)?.state).toBe("active");
  });

  it("records a terminal failure once the retry budget is gone", async () => {
    const reports: FailureEvent[] = [];

    const compute: ComputeProvider = {
      async findOffer() {
        return offer;
      },
      async createInstance() {
        return { instanceId: 1 };
      },
      async waitUntilReady() {
        throw Object.assign(new Error("The model container stopped while loading the model."), {
          name: "InstanceStartTimeoutError"
        });
      },
      async getInstanceLogs() {
        return "ValueError: The model's max seq len (262144) is larger than the maximum number of tokens that can be stored in KV cache (32768).";
      },
      async destroyInstance() {},
      isRetryableStartup() {
        return true;
      },
      isUnrecoverable() {
        return false;
      }
    };

    const orchestrator = new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "ok" }),
      idleTimeoutMinutes: 10,
      now: () => clock,
      startupRetries: () => 0,
      reportFailure: (event) => reports.push(event)
    });

    const estimate = await orchestrator.createEstimate("org/model");
    const session = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(session.id);

    expect(orchestrator.getSession(session.id)?.state).toBe("failed");
    // One attempt report plus the terminal summary.
    expect(reports).toHaveLength(2);
    expect(reports.at(-1)).toMatchObject({
      stage: "startup",
      errorClass: "StartupFailure"
    });
    expect(reports.at(-1)?.errorMessage).toMatch(/max seq len/i);
  });
});
