import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { seedAccount } from "../helpers/accounts";
import { SessionStore } from "../../src/main/services/sessions/store";

describe("session runtime configuration and restart audit", () => {
  let db: DatabaseConnection;
  let store: SessionStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedAccount(db);
    store = new SessionStore(db, "account-test");
    store.insert({
      id: "session-1",
      modelId: "org/model",
      state: "active",
      runtime: "vllm",
      label: "maia:session-1",
      gpuName: "Mock RTX 4090",
      gpuRamGb: 24,
      hourlyRateMicroUsd: 440_000,
      estimatedTotalMicroUsd: 1_000_000,
      startedAt: "2026-11-25T10:00:00.000Z",
      containerImage: "vllm/vllm-openai:latest"
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("persists the values the run was launched with", () => {
    store.recordRuntimeConfig("session-1", {
      current: { contextWindow: 32768, maxConcurrentRequests: 4 },
      defaults: { contextWindow: 32768, maxConcurrentRequests: 4 },
      contextWindowMax: 131072,
      contextWindowMaxSource: "model"
    });

    const session = store.get("session-1");
    expect(session?.runtimeConfig?.current.contextWindow).toBe(32768);
    expect(session?.runtimeConfig?.contextWindowMaxSource).toBe("model");
    expect(session?.restart).toBeNull();
  });

  it("keeps a restart in flight until it is cleared", () => {
    store.beginRestart("session-1", {
      startedAt: "2026-11-25T10:05:00.000Z",
      previous: { contextWindow: 32768, maxConcurrentRequests: 4 },
      target: { contextWindow: 65536, maxConcurrentRequests: 2 },
      phase: "booting"
    });

    expect(store.get("session-1")?.restart?.target.contextWindow).toBe(65536);

    store.clearRestart("session-1");
    expect(store.get("session-1")?.restart).toBeNull();
  });

  it("records and completes a restart audit row", () => {
    const id = store.recordRestart({
      sessionId: "session-1",
      previous: { contextWindow: 32768, maxConcurrentRequests: 4 },
      target: { contextWindow: 65536, maxConcurrentRequests: 2 },
      outcome: "started",
      requestedAt: "2026-11-25T10:05:00.000Z"
    });

    store.completeRestart(id, "succeeded");

    const history = store.getRestartHistory("session-1");
    expect(history).toHaveLength(1);
    expect(history[0]?.outcome).toBe("succeeded");
    expect(history[0]?.target.contextWindow).toBe(65536);
    expect(history[0]?.completedAt).not.toBeNull();
  });

  it("does not expose another account's restart history", () => {
    store.recordRestart({
      sessionId: "session-1",
      previous: { contextWindow: 4096, maxConcurrentRequests: 1 },
      target: { contextWindow: 8192, maxConcurrentRequests: 1 },
      outcome: "refused",
      reason: "no-op"
    });

    expect(new SessionStore(db, "account-other").getRestartHistory("session-1")).toEqual([]);
  });
});
