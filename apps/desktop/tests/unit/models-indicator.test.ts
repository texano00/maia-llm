import { describe, expect, it } from "vitest";
import type { Session, SessionState } from "@maia/contracts";
import { failedRunIds, modelsIndicator } from "../../src/renderer/features/models/indicator";

function run(id: string, state: SessionState): Session {
  return {
    id,
    modelId: "Qwen/Qwen2.5-7B-Instruct",
    state,
    runtime: "vllm",
    label: id,
    gpuName: "RTX 4090",
    gpuRamGb: 24,
    hourlyRateMicroUsd: 440_000,
    estimatedTotalMicroUsd: 220_000,
    startedAt: "2026-11-11T10:00:00.000Z",
    readyAt: null,
    endedAt: null,
    endReason: null,
    instanceId: null,
    simulated: false,
    events: []
  };
}

describe("Models navigation indicator", () => {
  it("is green while any run is serving", () => {
    expect(modelsIndicator([run("a", "active"), run("b", "failed")], [])).toBe("running");
  });

  it("is red for an unacknowledged failure and orange once acknowledged", () => {
    expect(modelsIndicator([run("a", "failed")], [])).toBe("failed");
    expect(modelsIndicator([run("a", "failed")], ["a"])).toBe("idle");
  });

  it("is orange when nothing is running and nothing failed", () => {
    expect(modelsIndicator([run("a", "ended")], [])).toBe("idle");
    expect(modelsIndicator([], [])).toBe("idle");
  });

  it("lists the failed run ids so Models can acknowledge them", () => {
    expect(failedRunIds([run("a", "active"), run("b", "failed"), run("c", "cancelled")])).toEqual(["b"]);
  });
});
