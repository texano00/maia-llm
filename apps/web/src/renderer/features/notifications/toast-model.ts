import type { Notification } from "@maia/contracts";

/**
 * The toast stack's rules, kept pure so they can be tested without a browser
 * (feature 011, FR-014/FR-018).
 */

export const TOAST_LIMIT = 3;
export const SUCCESS_TTL_MS = 8_000;
export const WARNING_TTL_MS = 10_000;

/** How long an entry stays on screen; `null` means "until dismissed". */
export function toastTtl(severity: Notification["severity"]): number | null {
  if (severity === "success") {
    return SUCCESS_TTL_MS;
  }
  if (severity === "warning") {
    return WARNING_TTL_MS;
  }
  return null;
}

export interface ToastView {
  notification: Notification;
  /** When it was claimed; the component uses this for its own timers. */
  shownAt: number;
}

/**
 * The entries to render: claimed on this surface, not yet expired, errors before
 * anything else, capped so a burst cannot cover the page.
 */
export function selectToasts(
  notifications: ReadonlyArray<Notification>,
  shownAt: ReadonlyMap<string, number>,
  now: number,
  limit: number = TOAST_LIMIT
): ToastView[] {
  return notifications
    .flatMap((notification) => {
      const at = shownAt.get(notification.key);
      if (at === undefined) {
        return [];
      }

      const ttl = toastTtl(notification.severity);
      if (ttl !== null && now - at >= ttl) {
        return [];
      }

      return [{ notification, shownAt: at }];
    })
    .sort((left, right) => {
      const rank = (severity: Notification["severity"]): number =>
        severity === "error" ? 0 : severity === "warning" ? 1 : 2;
      return rank(left.notification.severity) - rank(right.notification.severity);
    })
    .slice(0, limit);
}

/** Entries worth claiming for a toast at all. */
export function claimable(notification: Notification): boolean {
  return notification.severity === "success" || notification.severity === "error";
}
