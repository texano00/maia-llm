import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { NotificationSnapshot } from "@maia/contracts";

interface NotificationsValue {
  snapshot: NotificationSnapshot | null;
  reload(): Promise<void>;
  dismiss(key: string): Promise<void>;
  claim(key: string): Promise<boolean>;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

/**
 * One poll for every notification surface (feature 011).
 *
 * The bell and the toast stack must show the same thing at the same moment, and
 * two intervals would drift apart; this is the single reader of
 * `notifications.list`.
 */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<NotificationSnapshot | null>(null);

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
      // A hidden window has nothing to show; wake on the next visibility change.
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      void reload();
    }, 10_000);

    const onVisible = (): void => {
      if (!document.hidden) {
        void reload();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  const dismiss = useCallback(async (key: string) => {
    const result = await window.maia?.invoke<NotificationSnapshot>("notifications.dismiss", { key });
    if (result?.ok) {
      setSnapshot(result.data);
    }
  }, []);

  const claim = useCallback(async (key: string): Promise<boolean> => {
    const result = await window.maia?.invoke<{ shown: boolean; snapshot: NotificationSnapshot }>(
      "notifications.claim",
      { key }
    );
    if (!result?.ok) {
      return false;
    }

    setSnapshot(result.data.snapshot);
    return result.data.shown;
  }, []);

  const value = useMemo<NotificationsValue>(
    () => ({ snapshot, reload, dismiss, claim }),
    [snapshot, reload, dismiss, claim]
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) {
    throw new Error("useNotifications must be used inside NotificationProvider");
  }

  return value;
}
