import { describe, expect, it } from "vitest";
import { restartRequestSchema, restartResultSchema } from "@maia/contracts";

const config = {
  current: { contextWindow: 32768, maxConcurrentRequests: 4 },
  defaults: { contextWindow: 32768, maxConcurrentRequests: 4 },
  contextWindowMax: 131072,
  contextWindowMaxSource: "model" as const,
  concurrencyMax: 4,
  estimatedMaxContext: 131072,
  fits: true,
  restart: null
};

const session = {
  id: "s1",
  modelId: "org/model",
  state: "active" as const,
  runtime: "vllm" as const,
  label: "maia:s1",
  gpuName: "RTX 4090",
  gpuRamGb: 24,
  hourlyRateMicroUsd: 440_000,
  estimatedTotalMicroUsd: 220_000,
  startedAt: "2026-11-25T10:00:00.000Z",
  readyAt: null,
  endedAt: null,
  endReason: null,
  instanceId: 42,
  powerTier: "balanced" as const,
  capability: "text" as const,
  simulated: false,
  events: [],
  boot: null,
  endpoint: null,
  release: null,
  runtimeConfig: config,
  restart: null
};

describe("restart RPC contract", () => {
  it("requires an explicit confirmation and a value pair", () => {
    expect(() =>
      restartRequestSchema.parse({
        sessionId: "s1",
        confirmRestart: true,
        values: { contextWindow: 65536 }
      })
    ).toThrow();
  });

  it("accepts each result discriminator", () => {
    expect(
      restartResultSchema.parse({
        status: "restarted",
        session,
        config: { ...config, current: { contextWindow: 65536, maxConcurrentRequests: 2 } }
      }).status
    ).toBe("restarted");

    expect(
      restartResultSchema.parse({
        status: "failed",
        session: { ...session, state: "failed" },
        config,
        reason: "the machine went away"
      }).status
    ).toBe("failed");

    expect(
      restartResultSchema.parse({
        status: "fresh_run_required",
        session: { ...session, state: "failed" },
        reason: "replacement refused",
        estimate: {
          id: "e1",
          modelId: "org/model",
          createdAt: "2026-11-25T10:10:00.000Z",
          gpuName: "RTX 4090",
          gpuRamGb: 24,
          hourlyRateMicroUsd: 440_000,
          minimumMinutes: 5,
          expectedMinutes: 30,
          projectedTotalMicroUsd: 220_000,
          rangeMicroUsd: { low: 36_667, high: 440_000 },
          waitMinutes: { low: 0, high: 4 },
          currency: "USD",
          assumptions: [],
          notes: [],
          powerTier: "balanced",
          simulated: true
        }
      }).status
    ).toBe("fresh_run_required");
  });
});
