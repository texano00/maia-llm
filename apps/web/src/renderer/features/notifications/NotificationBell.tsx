import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Notification, NotificationSnapshot } from "@maia/contracts";
import { useWorkspace } from "../../shared/session/WorkspaceProvider";
import { useUiPreferences } from "../../shared/preferences/useUiPreferences";

/**
 * Header bell. Server-side conditions (credentials, balance) come from the main
 * process; run failures are derived from the active session list, which the
 * workspace already polls, so no extra channel or polling loop is added.
 */
export function NotificationBell() {
  const { sessions } = useWorkspace();
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<NotificationSnapshot | null>(null);
  const [open, setOpen] = useState(false);

  const reload = useCallback(async () => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    const result = await bridge.invoke<NotificationSnapshot>("notifications.list");
    if (result.ok) {
      setSnapshot(result.data);
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      void reload();
    }, 5_000);
    return () => clearInterval(timer);
  }, [reload]);

  const acknowledged = new Set(useUiPreferences().acknowledgedFailureIds);
  const failures: Notification[] = sessions
    .filter((session) => session.state === "failed" && !acknowledged.has(session.id))
    .map((session) => ({
      key: `run:failed:${session.id}`,
      severity: "error" as const,
      message: `${session.modelId} failed to start or stopped unexpectedly.`,
      action: { label: "View run", route: "/models" },
      createdAt: session.endedAt ?? session.startedAt
    }));

  const notifications = [...failures, ...(snapshot?.notifications ?? [])];
  const indicator = notifications.some((entry) => entry.severity === "error")
    ? "error"
    : notifications.length > 0
      ? "warning"
      : "none";

  async function dismiss(key: string): Promise<void> {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    const result = await bridge.invoke<NotificationSnapshot>("notifications.dismiss", { key });
    if (result.ok) {
      setSnapshot(result.data);
    }
  }

  return (
    <div className="notifications">
      <button
        type="button"
        className={`icon-button notifications-bell notifications-${indicator}`}
        aria-label={
          notifications.length > 0
            ? `Notifications (${notifications.length})`
            : "Notifications"
        }
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {indicator === "none" ? "🔔" : "🔔"}
        {notifications.length > 0 ? <span className="notifications-count">{notifications.length}</span> : null}
      </button>

      {open ? (
        <div className="notifications-popover" role="dialog" aria-label="Notifications">
          {notifications.length === 0 ? (
            <p className="muted small">Nothing needs your attention.</p>
          ) : (
            <ul>
              {notifications.map((entry) => (
                <li key={entry.key} className={`notification notification-${entry.severity}`}>
                  <span>{entry.message}</span>
                  <div className="notifications-actions">
                    {entry.action ? (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => {
                          setOpen(false);
                          navigate(entry.action!.route);
                        }}
                      >
                        {entry.action.label}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="icon-mini"
                      aria-label="Dismiss notification"
                      onClick={() => void dismiss(entry.key)}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
