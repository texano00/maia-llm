import type { Notification, NotificationSnapshot } from "@maia/contracts";
import type { SettingsStore } from "../settings/store";

export interface NotificationInput {
  key: string;
  severity: "warning" | "error";
  message: string;
  action?: { label: string; route: string };
}

type SettingsPort = Pick<SettingsStore, "get" | "update">;

/**
 * Current conditions surfaced in the header bell. Entries are keyed by a stable
 * condition key so a dismissal suppresses repeats until the condition resolves
 * and recurs. Nothing here is content: messages name providers and models only.
 */
export class NotificationCenter {
  private readonly entries = new Map<string, Notification>();

  constructor(
    private readonly settings: SettingsPort,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Adds or updates a condition, keeping the first-seen timestamp. */
  set(input: NotificationInput): void {
    const existing = this.entries.get(input.key);
    this.entries.set(input.key, {
      ...input,
      createdAt: existing?.createdAt ?? this.now().toISOString()
    });
  }

  /** Removes a condition; a later occurrence may notify again. */
  clear(key: string): void {
    this.entries.delete(key);
    const dismissed = this.settings.get().dismissedNotificationKeys;
    if (dismissed.includes(key)) {
      this.settings.update({ dismissedNotificationKeys: dismissed.filter((entry) => entry !== key) });
    }
  }

  dismiss(key: string): NotificationSnapshot {
    const dismissed = this.settings.get().dismissedNotificationKeys;
    if (!dismissed.includes(key)) {
      this.settings.update({ dismissedNotificationKeys: [...dismissed, key] });
    }

    return this.snapshot();
  }

  snapshot(): NotificationSnapshot {
    const dismissed = new Set(this.settings.get().dismissedNotificationKeys);
    const notifications = [...this.entries.values()]
      .filter((entry) => !dismissed.has(entry.key))
      .sort((left, right) => {
        if (left.severity !== right.severity) {
          return left.severity === "error" ? -1 : 1;
        }

        return right.createdAt.localeCompare(left.createdAt);
      });

    const indicator = notifications.some((entry) => entry.severity === "error")
      ? "error"
      : notifications.length > 0
        ? "warning"
        : "none";

    return { notifications, indicator };
  }
}
