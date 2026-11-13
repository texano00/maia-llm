import { describe, expect, it } from "vitest";
import type { Session, SessionState } from "@maia/contracts";
import {
  DEFAULT_STATUS_FILTER,
  emptyStateFor,
  filterRuns
} from "../../src/renderer/features/models/filter";
import { mergeRuns } from "../../src/renderer/features/models/merge";

function run(id: string, state: SessionState, startedAt: string): Session {
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

const initializing = run("initializing-run", "ready", "2026-11-11T09:00:00.000Z");
const running = run("running-run", "active", "2026-11-11T10:00:00.000Z");
const terminated = run("terminated-run", "ended", "2026-11-11T08:00:00.000Z");
const all = [running, initializing, terminated];

describe("status filter", () => {
  it("defaults to Running", () => {
    expect(DEFAULT_STATUS_FILTER).toBe("running");
    expect(filterRuns(all, DEFAULT_STATUS_FILTER).map((entry) => entry.id)).toEqual(["running-run"]);
  });

  it("selects exactly the matching runs for each status", () => {
    expect(filterRuns(all, "initializing").map((entry) => entry.id)).toEqual(["initializing-run"]);
    expect(filterRuns(all, "running").map((entry) => entry.id)).toEqual(["running-run"]);
    expect(filterRuns(all, "terminated").map((entry) => entry.id)).toEqual(["terminated-run"]);
  });

  it("returns every run for All", () => {
    expect(filterRuns(all, "all").map((entry) => entry.id)).toEqual([
      "running-run",
      "initializing-run",
      "terminated-run"
    ]);
  });

  it("treats every teardown state as terminated", () => {
    for (const state of ["ending", "ended", "cancelled", "failed"] as SessionState[]) {
      expect(filterRuns([run("run", state, "2026-11-11T10:00:00.000Z")], "terminated")).toHaveLength(1);
    }
  });

  it("explains an empty Running view differently from an empty history", () => {
    const runningEmpty = emptyStateFor("running");
    const terminatedEmpty = emptyStateFor("terminated");

    expect(runningEmpty.title).not.toBe(terminatedEmpty.title);
    expect(runningEmpty.title).toMatch(/no models are running/i);
    expect(terminatedEmpty.detail).toMatch(/session history/i);
  });
});

describe("mergeRuns", () => {
  it("shows one entry per run and orders newest first", () => {
    const merged = mergeRuns([running, initializing], [terminated, running]);

    expect(merged.map((entry) => entry.id)).toEqual(["running-run", "initializing-run", "terminated-run"]);
  });

  it("lets the live active row win over a stale history copy", () => {
    const stale = { ...running, state: "ending" as const };
    const merged = mergeRuns([running], [stale]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.state).toBe("active");
  });
});
