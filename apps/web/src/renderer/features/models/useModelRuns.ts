import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@maia/contracts";
import { useWorkspace } from "../../shared/session/WorkspaceProvider";
import { mergeRuns } from "./merge";

export interface ModelRunsValue {
  /** Active and persisted runs combined, newest first. */
  runs: Session[];
  /** Non-null when the history query failed; history is never silently empty. */
  historyError: string | null;
  reloadHistory(): Promise<void>;
}

/**
 * Data source for the Models view. Active sessions keep flowing through the
 * shared workspace poller; locally persisted terminal runs are fetched through
 * `session.history` and refreshed on the same five-second visible-window
 * cadence so a run that ends while the page is open shows up without a reload.
 *
 * History rows stay page-local: `WorkspaceProvider.sessions` remains the
 * active-only list that Chat and Catalogue consume.
 */
export function useModelRuns(): ModelRunsValue {
  const { sessions } = useWorkspace();
  const [history, setHistory] = useState<Session[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const reloadHistory = useCallback(async () => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    const result = await bridge.invoke<Session[]>("session.history");
    if (result.ok) {
      setHistory(result.data);
      setHistoryError(null);
    } else {
      setHistoryError(result.error.message);
    }
  }, []);

  useEffect(() => {
    void reloadHistory();

    const timer = setInterval(() => {
      // A hidden window has nothing to update; wake up on the next visibility change.
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }

      void reloadHistory();
    }, 5_000);

    const onVisible = (): void => {
      if (!document.hidden) {
        void reloadHistory();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reloadHistory]);

  const runs = useMemo(() => mergeRuns(sessions, history), [sessions, history]);

  return { runs, historyError, reloadHistory };
}
