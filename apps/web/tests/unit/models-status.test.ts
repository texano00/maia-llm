import { describe, expect, it } from "vitest";
import type { Session, SessionState } from "@maia/contracts";
import { toVisibleStatus } from "../../src/renderer/features/models/status";
import { ACCRUED_NOTE, describeRun } from "../../src/renderer/features/models/run-details";

function session(state: SessionState, overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    modelId: "Qwen/Qwen2.5-7B-Instruct",
    state,
    runtime: "vllm",
    label: "Qwen2.5 7B",
    gpuName: "RTX 4090",
    gpuRamGb: 24,
    hourlyRateMicroUsd: 440_000,
    estimatedTotalMicroUsd: 220_000,
    startedAt: "2026-11-11T10:00:00.000Z",
    readyAt: null,
    endedAt: null,
    endReason: null,
    instanceId: 42,
    simulated: false,
    events: [],
    ...overrides
  };
}

describe("toVisibleStatus", () => {
  it("projects every internal state onto exactly three visible statuses", () => {
    const expected: Record<SessionState, string> = {
      estimated: "initializing",
      provisioning: "initializing",
      ready: "initializing",
      active: "running",
      ending: "terminated",
      ended: "terminated",
      cancelled: "terminated",
      failed: "terminated"
    };

    for (const [state, visible] of Object.entries(expected)) {
      expect(toVisibleStatus(state as SessionState)).toBe(visible);
    }
  });
});

describe("describeRun", () => {
  const now = Date.parse("2026-11-11T10:05:00.000Z");

  it("marks runtime and cost values pending while initializing", () => {
    const details = describeRun(session("provisioning"), { now });

    expect(details.valuesPending).toBe(true);
    expect(details.elapsed).toBe("pending");
    expect(details.accrued).toBe("pending");
    expect(details.accruedMicroUsd).toBeNull();
    expect(details.durationMs).toBeNull();
  });

  it("computes elapsed time and accrued cost for a running run", () => {
    const details = describeRun(session("active", { readyAt: "2026-11-11T10:01:00.000Z" }), { now });

    expect(details.valuesPending).toBe(false);
    expect(details.elapsed).toBe("5m 00s");
    expect(details.accruedMicroUsd).toBe(36_667);
    expect(details.accrued).toBe("$0.04");
    expect(details.durationMs).toBe(300_000);
    expect(details.note).toBe(ACCRUED_NOTE);
  });

  it("uses the end timestamp for final duration and cost", () => {
    const details = describeRun(
      session("ended", {
        readyAt: "2026-11-11T10:01:00.000Z",
        endedAt: "2026-11-11T10:30:00.000Z",
        endReason: "user"
      }),
      { now: Date.parse("2026-11-12T00:00:00.000Z") }
    );

    expect(details.valuesPending).toBe(false);
    expect(details.durationMs).toBe(1_800_000);
    expect(details.elapsed).toBe("30m 00s");
    expect(details.accruedMicroUsd).toBe(220_000);
    expect(details.accrued).toBe("$0.22");
    expect(details.endTime).toBe("2026-11-11T10:30:00.000Z");
    expect(details.endReasonLabel).toBe("Ended by you");
    expect(details.endDetailsPending).toBe(false);
  });

  it("reports pending end details while teardown is in progress", () => {
    const details = describeRun(session("ending", { endReason: "user" }), { now });

    expect(details.endDetailsPending).toBe(true);
    expect(details.elapsed).toBe("pending");
    expect(details.accrued).toBe("pending");
  });

  it("reports unavailable values when terminal timestamps are missing", () => {
    const details = describeRun(session("failed", { endReason: "failure" }), { now });

    expect(details.endDetailsPending).toBe(false);
    expect(details.elapsed).toBe("unavailable");
    expect(details.accrued).toBe("unavailable");
    expect(details.endReasonLabel).toBe("Failed");
    expect(details.endTime).toBeNull();
  });
});
