import type { Notification, NotificationSnapshot } from "@maia/contracts";
import type { SettingsStore } from "../settings/store";

export interface NotificationInput {
  key: string;
  severity: "warning" | "error";
  message: string;
  action?: { label: string; route: string };
  /**
   * Setup requirements default to `false`: hiding "add your key" would leave the
   * account unable to act on it. Transient conditions, such as a low balance, are
   * dismissible and come back if the condition recurs.
   */
  dismissible?: boolean;
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
      dismissible: input.dismissible ?? true,
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
    // A setup requirement ignores the dismissal instead of failing the call: the
    // view may still render a close button from a stale snapshot.
    if (this.entries.get(key)?.dismissible === false) {
      return this.snapshot();
    }

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

        // Setup requirements stay on top: they are the ones the person must act on.
        if (left.dismissible !== right.dismissible) {
          return left.dismissible ? 1 : -1;
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
