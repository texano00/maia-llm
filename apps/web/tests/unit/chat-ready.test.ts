import { describe, expect, it } from "vitest";
import type { Session } from "@maia/contracts";
import { defaultSession, readySessions, sessionForModel } from "../../src/renderer/features/chat/ready";

function session(id: string, state: Session["state"], modelId = "Qwen/Qwen2.5-7B-Instruct"): Session {
  return {
    id,
    modelId,
    state,
    runtime: "vllm",
    label: id,
    gpuName: "RTX 4090",
    gpuRamGb: 24,
    hourlyRateMicroUsd: 440_000,
    estimatedTotalMicroUsd: 220_000,
    startedAt: "2026-11-12T10:00:00.000Z",
    readyAt: null,
    endedAt: null,
    endReason: null,
    instanceId: 42,
    powerTier: "balanced",
    capability: "text",
    simulated: false,
    events: []
  };
}

describe("chat model readiness", () => {
  it("offers only models that are serving", () => {
    const sessions = [
      session("starting", "provisioning"),
      session("warming", "ready"),
      session("live", "active"),
      session("closing", "ending"),
      session("done", "ended"),
      session("broken", "failed")
    ];

    expect(readySessions(sessions).map((entry) => entry.id)).toEqual(["live"]);
  });

  it("returns nothing when no model is ready", () => {
    expect(readySessions([session("starting", "provisioning")])).toEqual([]);
  });

  it("preselects the ready session for a conversation", () => {
    const sessions = [session("live", "active", "meta-llama/Llama-3.1-8B-Instruct")];

    expect(sessionForModel(sessions, "meta-llama/Llama-3.1-8B-Instruct")?.id).toBe("live");
    expect(sessionForModel(sessions, "other/model")).toBeNull();
    expect(sessionForModel(sessions, null)).toBeNull();
  });

  it("picks a ready model when a new chat has none", () => {
    const sessions = [session("live-a", "active"), session("live-b", "active", "other/model")];

    expect(defaultSession(sessions, null)?.id).toBe("live-a");
    // A model the user already chose stays chosen.
    expect(defaultSession(sessions, "live-b")?.id).toBe("live-b");
    expect(defaultSession([], null)).toBeNull();
  });
});
