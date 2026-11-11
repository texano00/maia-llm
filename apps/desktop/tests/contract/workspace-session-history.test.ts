import { describe, expect, it } from "vitest";
import type { Session } from "@maia/contracts";
import { IpcRegistry } from "../../src/main/ipc/registry";
import { registerWorkspaceHandlers } from "../../src/main/ipc/workspace";
import type { CatalogueService } from "../../src/main/services/catalogue/service";
import type { HistoryRepository } from "../../src/main/services/history/repository";
import type { ConversationImageStore } from "../../src/main/services/history/images";
import type { SessionOrchestrator } from "../../src/main/services/sessions/orchestrator";

function session(id: string, state: Session["state"], startedAt: string): Session {
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

interface HarnessOptions {
  active?: Session[];
  history?: Session[];
  failHistory?: boolean;
}

function harness(options: HarnessOptions = {}): IpcRegistry {
  const registry = new IpcRegistry();
  const sessions = {
    listSessions: () => options.active ?? [],
    listSessionHistory: () => {
      if (options.failHistory) {
        throw Object.assign(new Error("session history unavailable"), { code: "INTERNAL" });
      }
      return options.history ?? [];
    }
  } as unknown as SessionOrchestrator;

  registerWorkspaceHandlers({
    registry,
    catalogue: {} as CatalogueService,
    sessions,
    history: {} as HistoryRepository,
    images: {} as ConversationImageStore,
    broadcastChat: () => undefined
  });

  return registry;
}

describe("session.history IPC", () => {
  it("returns only terminal sessions and accepts an empty payload", async () => {
    const history = [
      session("ending-run", "ending", "2026-11-11T10:05:00.000Z"),
      session("ended-run", "ended", "2026-11-11T10:00:00.000Z")
    ];
    const registry = harness({
      active: [session("active-run", "active", "2026-11-11T10:10:00.000Z")],
      history
    });

    const result = await registry.invoke("session.history", {});

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data).toEqual(history);
    expect((result.data as Session[]).map((entry) => entry.state)).not.toContain("active");
  });

  it("tolerates an unknown payload, matching the session.list read", async () => {
    const registry = harness({ history: [session("ended-run", "ended", "2026-11-11T10:00:00.000Z")] });

    const result = await registry.invoke("session.history", { unexpected: "ignored" });

    expect(result.ok).toBe(true);
  });

  it("leaves session.list as the active-only query", async () => {
    const active = [session("active-run", "active", "2026-11-11T10:10:00.000Z")];
    const registry = harness({
      active,
      history: [session("ended-run", "ended", "2026-11-11T10:00:00.000Z")]
    });

    const result = await registry.invoke("session.list", {});

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data).toEqual(active);
    expect((result.data as Session[]).map((entry) => entry.state)).not.toContain("ended");
  });

  it("reports a storage failure as an error, not an empty history", async () => {
    const registry = harness({ failHistory: true });

    const result = await registry.invoke("session.history", {});

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.message).toBe("session history unavailable");
  });
});
