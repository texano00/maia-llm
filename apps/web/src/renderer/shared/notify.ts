/**
 * Browser notifications for the one moment that matters: the model a person is
 * paying for has actually started.
 *
 * A GPU takes minutes to boot, so the person leaves the tab. Without a
 * notification they come back to a machine that has been billing while they were
 * reading their mail. The alert is therefore tied to the session reaching
 * `ready`/`active`, not to the click that booked it — a notification saying
 * "starting" would be a lie for the next three minutes.
 *
 * Permission is requested on the click that starts a run: that is a user gesture,
 * which the Notifications API requires, and it is the moment the reason for the
 * permission is obvious.
 */

export type NotificationPermissionState = "default" | "granted" | "denied" | "unsupported";

export interface NotifyTarget {
  title: string;
  body: string;
  /** Collapses repeats for the same run. */
  tag: string;
  onClick?: () => void;
}

function api(): typeof Notification | null {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return null;
  }

  return window.Notification;
}

export function notificationPermission(): NotificationPermissionState {
  const notifications = api();
  return notifications ? (notifications.permission as NotificationPermissionState) : "unsupported";
}

/** Asks once, from a click. Never throws: a refused permission is not an error. */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  const notifications = api();
  if (!notifications) {
    return "unsupported";
  }
  if (notifications.permission !== "default") {
    return notifications.permission as NotificationPermissionState;
  }

  try {
    return (await notifications.requestPermission()) as NotificationPermissionState;
  } catch {
    return "denied";
  }
}

export function notify({ title, body, tag, onClick }: NotifyTarget): void {
  const notifications = api();
  if (!notifications || notifications.permission !== "granted") {
    return;
  }

  try {
    const notification = new notifications(title, { body, tag, icon: "/logo.png" });
    notification.onclick = () => {
      window.focus();
      onClick?.();
      notification.close();
    };
  } catch {
    // Some browsers refuse construction outside a service worker; the in-app
    // indicator still tells the story.
  }
}

export type RunPhase = "starting" | "running" | "failed" | "ended";

/** Which phase a session is in, for deciding whether a transition is worth an alert. */
export function runPhase(state: string): RunPhase {
  switch (state) {
    case "estimated":
    case "provisioning":
      return "starting";
    case "ready":
    case "active":
      return "running";
    case "failed":
      return "failed";
    default:
      return "ended";
  }
}

/**
 * True only for the transition a person is waiting for: a run that was starting
 * and is now up (or dead). Running → running is not news.
 */
export function worthNotifying(previous: string | undefined, next: string): boolean {
  if (previous === undefined) {
    return false;
  }

  const before = runPhase(previous);
  const after = runPhase(next);
  return before === "starting" && (after === "running" || after === "failed");
}

/**
 * Alerts for every run that became ready since the last poll. Returns the ids so
 * the caller can record what it announced and never repeats itself.
 */
export function announceReadyRuns(
  previous: Readonly<Record<string, string>>,
  sessions: ReadonlyArray<{ id: string; modelId: string; state: string }>,
  announce: (target: NotifyTarget) => void,
  onOpen: (sessionId: string) => void
): void {
  const hidden = typeof document !== "undefined" && document.hidden;

  for (const session of sessions) {
    if (!worthNotifying(previous[session.id], session.state)) {
      continue;
    }

    // A tab the person is looking at needs no system alert: the screen already
    // changed under their eyes.
    if (!hidden) {
      continue;
    }

    if (runPhase(session.state) === "failed") {
      announce({
        title: "The model did not start",
        body: `${session.modelId} could not be started. Open Models to see why.`,
        tag: `run-${session.id}`,
        onClick: () => onOpen(session.id)
      });
      continue;
    }

    announce({
      title: "Your model is ready",
      body: `${session.modelId} is running. The GPU is billing from now.`,
      tag: `run-${session.id}`,
      onClick: () => onOpen(session.id)
    });
  }
}
