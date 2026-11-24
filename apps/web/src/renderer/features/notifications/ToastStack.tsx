import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Notification } from "@maia/contracts";
import { useNotifications } from "./NotificationProvider";
import { claimable, selectToasts } from "./toast-model";

/**
 * Top-right readiness and failure notices (feature 011, FR-014).
 *
 * The entry is claimed once per account, so a second tab or a reload stays
 * quiet; the address is the point of the message, so it is shown as a link and
 * offered as a copy. Nothing here covers the composer or steals focus.
 */
export function ToastStack() {
  const { snapshot, claim, dismiss } = useNotifications();
  const navigate = useNavigate();
  const [shownAt, setShownAt] = useState<Map<string, number>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  const claiming = useRef<Set<string>>(new Set());

  // Claim every eligible entry once; the server answers `shown` only the first
  // time, so a second tab (or this one after a reload) renders nothing.
  useEffect(() => {
    const entries = snapshot?.notifications ?? [];

    for (const entry of entries) {
      if (!claimable(entry) || shownAt.has(entry.key) || claiming.current.has(entry.key)) {
        continue;
      }

      claiming.current.add(entry.key);
      void claim(entry.key).then((shown) => {
        if (shown) {
          setShownAt((current) => new Map(current).set(entry.key, Date.now()));
        }
        claiming.current.delete(entry.key);
      });
    }
  }, [snapshot, shownAt, claim]);

  // One tick so success entries disappear on time without a second poll.
  useEffect(() => {
    if (shownAt.size === 0) {
      return;
    }

    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [shownAt]);

  const visible = selectToasts(snapshot?.notifications ?? [], shownAt, now);

  if (visible.length === 0) {
    return null;
  }

  const copy = async (entry: Notification): Promise<void> => {
    if (!entry.endpoint) {
      return;
    }
    await navigator.clipboard.writeText(entry.endpoint.baseUrl).catch(() => undefined);
  };

  return (
    <div className="toast-stack" aria-live="polite">
      {visible.map(({ notification }) => (
        <div
          key={notification.key}
          className={`toast toast-${notification.severity}`}
          role={notification.severity === "error" ? "alert" : "status"}
        >
          <div className="toast-body">
            <p className="toast-message">{notification.message}</p>
            {notification.endpoint ? (
              <a
                className="toast-link"
                href={notification.endpoint.baseUrl.replace(/\/v1$/, "")}
                target="_blank"
                rel="noreferrer noopener"
              >
                {notification.endpoint.host}:{notification.endpoint.port}
              </a>
            ) : null}
          </div>

          <div className="toast-actions">
            {notification.endpoint ? (
              <button type="button" className="ghost-button" onClick={() => void copy(notification)}>
                Copy
              </button>
            ) : null}
            {notification.route ? (
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  navigate(notification.route ?? "/models");
                  setShownAt((current) => {
                    const next = new Map(current);
                    next.delete(notification.key);
                    return next;
                  });
                }}
              >
                {notification.severity === "success" ? "Open chat" : "View run"}
              </button>
            ) : null}
            {notification.action ? (
              <button
                type="button"
                className="ghost-button"
                onClick={() => navigate(notification.action?.route ?? "/catalogue")}
              >
                {notification.action.label}
              </button>
            ) : null}
            <button
              type="button"
              className="icon-mini"
              aria-label="Dismiss notification"
              onClick={() => {
                setShownAt((current) => {
                  const next = new Map(current);
                  next.delete(notification.key);
                  return next;
                });
                if (notification.severity !== "success") {
                  void dismiss(notification.key);
                }
              }}
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
