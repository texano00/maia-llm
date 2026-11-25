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

describe("runtime configuration flow", () => {
  let db: DatabaseConnection;
  let store: SessionStore;
  let orchestrator: SessionOrchestrator;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedAccount(db);
    store = new SessionStore(db, "account-test");
    orchestrator = new SessionOrchestrator({
      store,
      compute: createMockComputeProvider({ offer, provisionDelayMs: 0 }),
      inference: createMockInference(),
      idleTimeoutMinutes: 10,
      contextWindowFor: () => 131_072,
      runtimeLimitsFor: () => ({ estimatedMaxContext: 131_072, concurrencyMax: 4 })
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  async function running(): Promise<string> {
    const estimate = await orchestrator.createEstimate("org/model", 30);
    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    await orchestrator.awaitProvisioning(started.id);
    return started.id;
  }

  it("reports the model's documented maximum and the engine defaults", async () => {
    const sessionId = await running();
    const config = orchestrator.runtimeConfig(sessionId);

    expect(config?.contextWindowMax).toBe(131_072);
    expect(config?.contextWindowMaxSource).toBe("model");
    expect(config?.current.contextWindow).toBe(32_768);
    expect(config?.current.maxConcurrentRequests).toBe(4);
    expect(config?.restart).toBeNull();
  });

  it("reports a product ceiling when the model documents none", async () => {
    const plain = new SessionOrchestrator({
      store,
      compute: createMockComputeProvider({ offer, provisionDelayMs: 0 }),
      inference: createMockInference(),
      idleTimeoutMinutes: 10,
      contextWindowFor: () => null,
      runtimeLimitsFor: () => ({ estimatedMaxContext: 32768, concurrencyMax: 8 })
    });

    const estimate = await plain.createEstimate("org/model", 30);
    const started = await plain.start({ estimateId: estimate.id, confirmEstimate: true });
    await plain.awaitProvisioning(started.id);

    const config = plain.runtimeConfig(started.id);
    expect(config?.contextWindowMax).toBeNull();
    expect(config?.contextWindowMaxSource).toBe("product");
  });

  it("persists the applied values only after the restart succeeds", async () => {
    const sessionId = await running();

    await orchestrator.restart(sessionId, { contextWindow: 65_536, maxConcurrentRequests: 2 });

    const config = orchestrator.runtimeConfig(sessionId);
    expect(config?.current).toEqual({ contextWindow: 65_536, maxConcurrentRequests: 2 });
    expect(config?.defaults.contextWindow).toBe(32_768);
    expect(config?.restart).toBeNull();
  });
});
