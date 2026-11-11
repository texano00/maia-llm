import { describe, expect, it } from "vitest";
import type { Session, SessionState } from "@maia/contracts";
import { mergeRuns } from "../../src/renderer/features/models/merge";
import { isChatEligible } from "../../src/renderer/features/models/status";

function run(id: string, state: SessionState, startedAt = "2026-11-11T10:00:00.000Z"): Session {
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
    startedAt,
    readyAt: null,
    endedAt: null,
    endReason: null,
    instanceId: null,
    simulated: false,
    events: []
  };
}

describe("Chat eligibility", () => {
  it("offers only a running session to Chat", () => {
    expect(isChatEligible("active")).toBe(true);

    for (const state of [
      "estimated",
      "provisioning",
      "ready",
      "ending",
      "ended",
      "cancelled",
      "failed"
    ] as SessionState[]) {
      expect(isChatEligible(state)).toBe(false);
    }
  });

  it("leaves the active session list untouched when history is merged", () => {
    const active = [run("active-run", "active")];
    const merged = mergeRuns(active, [run("ended-run", "ended", "2026-11-11T09:00:00.000Z")]);

    // History stays page-local: Chat still sees only the active list.
    expect(active.map((entry) => entry.id)).toEqual(["active-run"]);
    expect(merged.map((entry) => entry.id)).toEqual(["active-run", "ended-run"]);
  });
});
