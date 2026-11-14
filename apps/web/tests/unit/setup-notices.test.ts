import { describe, expect, it } from "vitest";
import type { ProviderHealth } from "@maia/contracts";
import {
  deriveHealthNotifications,
  HEALTH_NOTIFICATION_KEYS
} from "../../src/main/services/health/monitor";
import { NotificationCenter } from "../../src/main/services/notifications/center";
import { defaultAppSettings, type SettingsStore } from "../../src/main/services/settings/store";

const CHECKED_AT = "2026-11-14T10:00:00.000Z";

function health(overrides: Partial<ProviderHealth> = {}): ProviderHealth {
  return {
    huggingface: { state: "ok", checkedAt: CHECKED_AT },
    vastai: { state: "ok", checkedAt: CHECKED_AT },
    balance: { state: "known", amountMicroUsd: 25_000_000, checkedAt: CHECKED_AT },
    thresholdMicroUsd: 2_000_000,
    ...overrides
  };
}

/** In-memory settings, so the centre's dismissal list is real. */
function centre(): { notifications: NotificationCenter; settings: SettingsStore } {
  let current = { ...defaultAppSettings, dismissedNotificationKeys: [] as string[] };
  const settings = {
    get: () => current,
    update: (patch: Record<string, unknown>) => {
      current = { ...current, ...patch } as typeof current;
      return current;
    }
  } as unknown as SettingsStore;

  return { notifications: new NotificationCenter(settings), settings };
}

describe("setup notices", () => {
  it("stays quiet when both keys work and the balance is comfortable", () => {
    expect(deriveHealthNotifications(health())).toEqual([]);
  });

  it("asks for each missing key and routes to its own section", () => {
    const entries = deriveHealthNotifications(
      health({
        huggingface: { state: "missing", checkedAt: CHECKED_AT },
        vastai: { state: "missing", checkedAt: CHECKED_AT }
      })
    );

    const routes = Object.fromEntries(entries.map((entry) => [entry.key, entry.action?.route]));
    expect(routes["credential:huggingface:missing"]).toBe("/settings?section=huggingface");
    expect(routes["credential:vastai:missing"]).toBe("/settings?section=vastai");
    expect(entries.every((entry) => entry.dismissible === false)).toBe(true);
  });

  it("distinguishes a rejected key from a missing one", () => {
    const entries = deriveHealthNotifications(
      health({ vastai: { state: "invalid", checkedAt: CHECKED_AT } })
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe("credential:vastai:invalid");
    expect(entries[0]?.severity).toBe("error");
    expect(entries[0]?.message).toMatch(/rejected/i);
  });

  it("treats an unreadable provider as no news rather than a fault", () => {
    const entries = deriveHealthNotifications(
      health({
        huggingface: { state: "unknown", checkedAt: CHECKED_AT },
        vastai: { state: "unknown", checkedAt: CHECKED_AT },
        balance: { state: "unknown", amountMicroUsd: null, checkedAt: CHECKED_AT }
      })
    );

    expect(entries).toEqual([]);
  });

  it("warns about a balance below the threshold, and only then", () => {
    const low = deriveHealthNotifications(
      health({ balance: { state: "known", amountMicroUsd: 500_000, checkedAt: CHECKED_AT } })
    );
    const exactly = deriveHealthNotifications(
      health({ balance: { state: "known", amountMicroUsd: 2_000_000, checkedAt: CHECKED_AT } })
    );

    expect(low.map((entry) => entry.key)).toEqual(["balance:below-threshold"]);
    expect(low[0]?.action?.route).toBe("/settings?section=vastai");
    expect(exactly).toEqual([]);
  });

  it("keeps a setup requirement after a dismissal, but drops a transient one", () => {
    const { notifications } = centre();
    for (const entry of deriveHealthNotifications(
      health({
        vastai: { state: "missing", checkedAt: CHECKED_AT },
        balance: { state: "known", amountMicroUsd: 100_000, checkedAt: CHECKED_AT }
      })
    )) {
      notifications.set(entry);
    }

    notifications.dismiss("credential:vastai:missing");
    notifications.dismiss("balance:below-threshold");

    const keys = notifications.snapshot().notifications.map((entry) => entry.key);
    expect(keys).toContain("credential:vastai:missing");
    expect(keys).not.toContain("balance:below-threshold");
  });

  it("shows setup requirements before transient notices of the same severity", () => {
    const { notifications } = centre();
    notifications.set({
      key: "balance:below-threshold",
      severity: "warning",
      message: "Balance is low.",
      dismissible: true
    });
    notifications.set({
      key: "credential:vastai:missing",
      severity: "warning",
      message: "Add your vast.ai key.",
      dismissible: false
    });

    expect(notifications.snapshot().notifications.map((entry) => entry.key)).toEqual([
      "credential:vastai:missing",
      "balance:below-threshold"
    ]);
  });

  it("clears a resolved condition and resets its dismissal", () => {
    const { notifications } = centre();
    notifications.set({
      key: "balance:below-threshold",
      severity: "warning",
      message: "Balance is low.",
      dismissible: true
    });
    notifications.dismiss("balance:below-threshold");
    expect(notifications.snapshot().notifications).toEqual([]);

    for (const key of HEALTH_NOTIFICATION_KEYS) {
      notifications.clear(key);
    }

    notifications.set({
      key: "balance:below-threshold",
      severity: "warning",
      message: "Balance is low again.",
      dismissible: true
    });
    expect(notifications.snapshot().notifications).toHaveLength(1);
  });
});
