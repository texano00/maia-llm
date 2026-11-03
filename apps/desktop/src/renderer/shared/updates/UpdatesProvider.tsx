import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import type { AppInfo, UpdateStatus } from "@maia/contracts";

type UpdateAction = "update.check" | "update.download" | "update.install";

interface UpdatesValue {
  status: UpdateStatus | null;
  appInfo: AppInfo | null;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
}

const UpdatesContext = createContext<UpdatesValue | null>(null);

/**
 * Single subscription point for update state. The main process pushes status
 * changes, so every consumer (info popover, toast, settings) stays in sync.
 */
export function UpdatesProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    let mounted = true;

    void bridge
      .getVersions()
      .then((info) => {
        if (mounted) {
          setAppInfo(info);
        }
      })
      .catch(() => undefined);

    void bridge.invoke<UpdateStatus>("update.status").then((result) => {
      if (mounted && result.ok) {
        setStatus(result.data);
      }
    });

    const unsubscribe = bridge.onUpdateStatus((next) => setStatus(next));

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const run = useCallback(async (channel: UpdateAction) => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    const result = await bridge.invoke<UpdateStatus>(channel);
    if (result.ok) {
      setStatus(result.data);
    }
  }, []);

  const value = useMemo<UpdatesValue>(
    () => ({
      status,
      appInfo,
      check: () => run("update.check"),
      download: () => run("update.download"),
      install: () => run("update.install")
    }),
    [appInfo, run, status]
  );

  return <UpdatesContext.Provider value={value}>{children}</UpdatesContext.Provider>;
}

export function useUpdates(): UpdatesValue {
  const value = useContext(UpdatesContext);

  if (!value) {
    throw new Error("useUpdates must be used inside an UpdatesProvider");
  }

  return value;
}
