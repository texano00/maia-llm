import { describe, expect, it } from "vitest";
import type { Session } from "@maia/contracts";
import { validateRestart } from "../../src/main/services/sessions/restart-policy";

function session(patch: Partial<Session> = {}): Session {
  return {
    id: "s1",
    modelId: "org/model",
    state: "active",
    runtime: "vllm",
    label: "maia:s1",
    gpuName: "RTX 4090",
    gpuRamGb: 24,
    hourlyRateMicroUsd: 440_000,
    estimatedTotalMicroUsd: 220_000,
    startedAt: "2026-11-25T10:00:00.000Z",
    readyAt: "2026-11-25T10:02:00.000Z",
    endedAt: null,
    endReason: null,
    instanceId: 42,
    powerTier: "balanced",
    capability: "text",
    simulated: false,
    events: [],
    boot: null,
    endpoint: null,
    release: null,
    runtimeConfig: null,
    restart: null,
    ...patch
  };
}

const current = { contextWindow: 32768, maxConcurrentRequests: 4 };

function check(patch: Partial<Session>, values = { contextWindow: 65536, maxConcurrentRequests: 2 }) {
  return validateRestart({
    session: session(patch),
    values,
    current,
    contextWindowMax: 131072,
    concurrencyMax: 4,
    capMicroUsd: 0,
    accruedMicroUsd: 0
  });
}

describe("restart policy", () => {
  it("accepts a value the model documents", () => {
    expect(check({})).toEqual({
      ok: true,
      values: { contextWindow: 65536, maxConcurrentRequests: 2 }
    });
  });

  it("refuses a second restart while one is in flight", () => {
    const result = check({
      restart: {
        startedAt: "2026-11-25T10:05:00.000Z",
        previous: current,
        target: { contextWindow: 65536, maxConcurrentRequests: 2 },
        phase: "booting"
      }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("SESSION_CONFLICT");
    }
  });

  it("refuses a no-op", () => {
    const result = check({}, { contextWindow: 32768, maxConcurrentRequests: 4 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.message).toMatch(/already in force/i);
    }
  });

  it("refuses a terminal run", () => {
    const result = check({ state: "ending" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("MODEL_NOT_READY");
    }
  });

  it("refuses a context above the model maximum", () => {
    const result = check({}, { contextWindow: 262144, maxConcurrentRequests: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("VALIDATION_FAILED");
    }
  });

  it("refuses more concurrency than the card can serve", () => {
    const result = check({}, { contextWindow: 65536, maxConcurrentRequests: 6 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.message).toMatch(/between 1 and 4/);
    }
  });

  it("refuses when the cap is already reached", () => {
    const result = validateRestart({
      session: session(),
      values: { contextWindow: 65536, maxConcurrentRequests: 1 },
      current,
      contextWindowMax: 131072,
      concurrencyMax: 4,
      capMicroUsd: 1_000_000,
      accruedMicroUsd: 1_000_000
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("ESTIMATE_REQUIRED");
    }
  });
});
