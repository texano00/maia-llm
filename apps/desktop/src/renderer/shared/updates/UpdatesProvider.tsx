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
  /** False when the preload bridge failed to load; every IPC call is a no-op. */
  bridgeAvailable: boolean;
  lastError: string | null;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
}

const BRIDGE_MISSING_MESSAGE =
  "The application bridge is unavailable, so settings and updates cannot be reached. Reinstall Maia LLM.";

const UpdatesContext = createContext<UpdatesValue | null>(null);

/**
 * Single subscription point for update state. The main process pushes status
 * changes, so every consumer (info popover, toast, settings) stays in sync.
 */
export function UpdatesProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [bridgeAvailable, setBridgeAvailable] = useState(true);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = window.maia;
    if (!bridge) {
      setBridgeAvailable(false);
      setLastError(BRIDGE_MISSING_MESSAGE);
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
      .catch((error: unknown) => {
        if (mounted) {
          setLastError(error instanceof Error ? error.message : String(error));
        }
      });

    void bridge.invoke<UpdateStatus>("update.status").then((result) => {
      if (!mounted) {
        return;
      }

      if (result.ok) {
        setStatus(result.data);
      } else {
        setLastError(result.error.message);
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
      setBridgeAvailable(false);
      setLastError(BRIDGE_MISSING_MESSAGE);
      return;
    }

    try {
      const result = await bridge.invoke<UpdateStatus>(channel);
      if (result.ok) {
        setStatus(result.data);
        setLastError(null);
      } else {
        setLastError(result.error.message);
      }
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const value = useMemo<UpdatesValue>(
    () => ({
      status,
      appInfo,
      bridgeAvailable,
      lastError,
      check: () => run("update.check"),
      download: () => run("update.download"),
      install: () => run("update.install")
    }),
    [appInfo, bridgeAvailable, lastError, run, status]
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
