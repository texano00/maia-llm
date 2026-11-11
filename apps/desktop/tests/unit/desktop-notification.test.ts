import { describe, expect, it } from "vitest";
import type { Session, SessionState } from "@maia/contracts";
import { ReadinessNotifier, type DesktopNotificationBackend } from "../../src/main/services/notifications/desktop";
import { ReadinessWatcher } from "../../src/main/services/notifications/readiness-watcher";

interface Shown {
  title: string;
  body: string;
  onClick: () => void;
}

function backend(options: { supported?: boolean } = {}): DesktopNotificationBackend & { shown: Shown[] } {
  const shown: Shown[] = [];
  return {
    shown,
    supported: () => options.supported ?? true,
    show: (payload, onClick) => shown.push({ ...payload, onClick })
  };
}

describe("ReadinessNotifier", () => {
  it("delivers once per run while the app is unfocused", () => {
    const notifications = backend();
    const activated: string[] = [];
    const notifier = new ReadinessNotifier({
      backend: notifications,
      isFocused: () => false,
      onActivate: (sessionId) => activated.push(sessionId)
    });

    expect(notifier.notifyReady({ id: "s1", modelId: "Qwen/Qwen2.5-7B-Instruct" })).toBe(true);
    expect(notifier.notifyReady({ id: "s1", modelId: "Qwen/Qwen2.5-7B-Instruct" })).toBe(false);

    expect(notifications.shown).toHaveLength(1);
    expect(notifications.shown[0]?.body).toContain("Qwen/Qwen2.5-7B-Instruct");

    notifications.shown[0]?.onClick();
    expect(activated).toEqual(["s1"]);
  });

  it("stays silent when the app is in front", () => {
    const notifications = backend();
    const notifier = new ReadinessNotifier({
      backend: notifications,
      isFocused: () => true,
      onActivate: () => undefined
    });

    expect(notifier.notifyReady({ id: "s1", modelId: "m" })).toBe(false);
    expect(notifications.shown).toEqual([]);
  });

  it("reports an unsupported platform once", () => {
    const notifications = backend({ supported: false });
    let unsupported = 0;
    const notifier = new ReadinessNotifier({
      backend: notifications,
      isFocused: () => false,
      onActivate: () => undefined,
      onUnsupported: () => {
        unsupported += 1;
      }
    });

    notifier.notifyReady({ id: "s1", modelId: "m" });
    notifier.notifyReady({ id: "s2", modelId: "m" });
    expect(unsupported).toBe(1);
  });
});

function session(id: string, state: SessionState): Session {
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

describe("ReadinessWatcher", () => {
  it("notifies exactly when a run first becomes active", () => {
    let current: Session[] = [session("s1", "provisioning")];
    const notifications = backend();
    const notifier = new ReadinessNotifier({
      backend: notifications,
      isFocused: () => false,
      onActivate: () => undefined
    });
    const watcher = new ReadinessWatcher({ listSessions: () => current, notifier });

    watcher.tick();
    expect(notifications.shown).toHaveLength(0);

    current = [session("s1", "active")];
    watcher.tick();
    watcher.tick();
    expect(notifications.shown).toHaveLength(1);
  });
});
