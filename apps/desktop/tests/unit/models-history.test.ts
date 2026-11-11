import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session, SessionState } from "@maia/contracts";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { SessionStore } from "../../src/main/services/sessions/store";

const TERMINAL_STATES: SessionState[] = ["ending", "ended", "cancelled", "failed"];

function ids(sessions: Session[]): string[] {
  return sessions.map((session) => session.id);
}

describe("SessionStore history", () => {
  let db: DatabaseConnection;
  let store: SessionStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SessionStore(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function seed(
    id: string,
    state: SessionState,
    startedAt: string,
    patch: { endedAt?: string; endReason?: Session["endReason"] } = {}
  ): void {
    store.insert({
      id,
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      state,
      runtime: "vllm",
      label: `maia:${id}`,
      gpuName: "RTX 4090",
      gpuRamGb: 24,
      hourlyRateMicroUsd: 440_000,
      estimatedTotalMicroUsd: 220_000,
      startedAt,
      containerImage: "vllm/vllm-openai:latest"
    });
    store.transition(id, state, { ...patch });
  }

  it("returns terminal rows newest first", () => {
    seed("ended-old", "ended", "2026-01-01T10:00:00.000Z", { endedAt: "2026-01-01T10:30:00.000Z", endReason: "user" });
    seed("active-run", "active", "2026-01-02T10:00:00.000Z");
    seed("provisioning-run", "provisioning", "2026-01-03T10:00:00.000Z");
    seed("failed-run", "failed", "2026-01-04T10:00:00.000Z", { endedAt: "2026-01-04T10:05:00.000Z", endReason: "failure" });
    seed("cancelled-run", "cancelled", "2026-01-05T10:00:00.000Z", { endedAt: "2026-01-05T10:01:00.000Z", endReason: "user" });
    seed("ending-run", "ending", "2026-01-06T10:00:00.000Z", { endReason: "user" });
    seed("ready-run", "ready", "2026-01-07T10:00:00.000Z");
    seed("estimated-run", "estimated", "2026-01-08T10:00:00.000Z");

    expect(ids(store.getTerminated())).toEqual(["ending-run", "cancelled-run", "failed-run", "ended-old"]);
  });

  it("keeps the active list free of terminal rows", () => {
    seed("ended-run", "ended", "2026-01-01T10:00:00.000Z", { endedAt: "2026-01-01T10:30:00.000Z", endReason: "user" });
    seed("active-run", "active", "2026-01-02T10:00:00.000Z");
    seed("provisioning-run", "provisioning", "2026-01-03T10:00:00.000Z");
    seed("ready-run", "ready", "2026-01-04T10:00:00.000Z");
    seed("estimated-run", "estimated", "2026-01-05T10:00:00.000Z");

    const active = ids(store.getActive());
    expect(active).toEqual(["estimated-run", "ready-run", "provisioning-run", "active-run"]);
    for (const state of TERMINAL_STATES) {
      expect(store.getActive().map((session) => session.state)).not.toContain(state);
    }
  });

  it("includes the bounded lifecycle event log for a terminated run", () => {
    seed("failed-run", "failed", "2026-01-04T10:00:00.000Z", { endedAt: "2026-01-04T10:05:00.000Z", endReason: "failure" });
    store.appendEvent("failed-run", "error", "Engine core initialization failed");

    const [run] = store.getTerminated();
    expect(run?.events).toHaveLength(1);
    expect(run?.events[0]?.message).toBe("Engine core initialization failed");
    expect(run?.endReason).toBe("failure");
    expect(run?.endedAt).toBe("2026-01-04T10:05:00.000Z");
  });

  it("retains terminal runs regardless of age", () => {
    seed("ancient-run", "ended", "2024-01-01T10:00:00.000Z", {
      endedAt: "2024-01-01T10:45:00.000Z",
      endReason: "idle"
    });

    expect(ids(store.getTerminated())).toEqual(["ancient-run"]);
    expect(ids(store.getTerminated())).toEqual(["ancient-run"]);
  });
});
