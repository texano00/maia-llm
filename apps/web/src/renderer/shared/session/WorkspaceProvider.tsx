import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import type {
  CatalogueModel,
  CatalogueResult,
  CatalogueSnapshotInfo,
  CatalogueSort,
  Estimate,
  ModelDetail,
  PowerTier,
  Session,
  UseCaseCard
} from "@maia/contracts";
import { useUiPreferences } from "../preferences/useUiPreferences";
import { updatePreferences } from "../preferences/store";

export type CatalogueMode = "basic" | "advanced";

interface WorkspaceValue {
  models: CatalogueModel[];
  stale: boolean;
  loadingCatalogue: boolean;
  /** Which catalogue snapshot the list came from (null for a Hub listing). */
  snapshot: CatalogueSnapshotInfo | null;
  search: string;
  setSearch(value: string): void;
  sort: CatalogueSort;
  setSort(value: CatalogueSort): void;
  capability: string;
  setCapability(value: string): void;
  /** Hide models the backend says no engine can serve. On by default. */
  supportedOnly: boolean;
  setSupportedOnly(value: boolean): void;
  /** Basic mode = curated cards; advanced mode = the full catalogue list. */
  mode: CatalogueMode;
  setMode(value: CatalogueMode): void;
  useCases: UseCaseCard[];
  reloadUseCases(): Promise<void>;
  refreshCatalogue(): Promise<void>;
  selectModel(id: string): Promise<void>;
  selected: ModelDetail | null;
  /** Estimates are kept per model, so several models can be prepared at once. */
  estimates: Record<string, Estimate>;
  preparing: boolean;
  sessions: Session[];
  /** Model ids with a start request in flight (not the same as "provisioning"). */
  startingIds: string[];
  /** Session the user just started; the chat screen selects it once. */
  focusSessionId: string | null;
  clearFocusSession(): void;
  error: string | null;
  clearError(): void;
  prepareEstimate(modelId: string, powerTier?: PowerTier): Promise<void>;
  startSession(modelId: string, confirmGatedAccess?: boolean): Promise<Session | null>;
  reloadSessions(): Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

/** Catalogue and provisioning state shared by the catalogue and chat screens. */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [models, setModels] = useState<CatalogueModel[]>([]);
  const [stale, setStale] = useState(false);
  const [loadingCatalogue, setLoadingCatalogue] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<CatalogueSort>("downloads");
  const [capability, setCapability] = useState("");
  // FR-089: unsupported models are hidden until the user asks to see them. The
  // portal flags things vLLM cannot serve, and renting a GPU for one of those
  // costs money before it fails.
  const [supportedOnly, setSupportedOnly] = useState(true);
  const [snapshot, setSnapshot] = useState<CatalogueSnapshotInfo | null>(null);
  // Basic mode is the product default once the backend publishes use cases; a
  // deployment without them starts on the full list instead of an empty screen.
  const { catalogueMode: mode } = useUiPreferences();
  const setMode = useCallback((value: CatalogueMode): void => {
    updatePreferences({ catalogueMode: value });
  }, []);
  const [useCases, setUseCases] = useState<UseCaseCard[]>([]);
  const [selected, setSelected] = useState<ModelDetail | null>(null);
  const [estimates, setEstimates] = useState<Record<string, Estimate>>({});
  const [preparing, setPreparing] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [startingIds, setStartingIds] = useState<string[]>([]);
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadSessions = useCallback(async () => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    const result = await bridge.invoke<Session[]>("session.list");
    if (result.ok) {
      // Returning the previous array keeps the provider value stable, so the
      // whole tree does not re-render every polling tick.
      setSessions((current) => (sameSessions(current, result.data) ? current : result.data));
    }
  }, []);

  const loadCatalogue = useCallback(
    async (term: string, order: CatalogueSort, feature: string, runnableOnly: boolean) => {
      const bridge = window.maia;
      if (!bridge) {
        return;
      }

      setLoadingCatalogue(true);
      const result = await bridge.invoke<CatalogueResult>("catalogue.search", {
        search: term || undefined,
        sort: order,
        capability: feature || undefined,
        ...(runnableOnly ? { supportedOnly: true } : {}),
        limit: 100
      });
      setLoadingCatalogue(false);

      if (result.ok) {
        setModels(result.data.models);
        setStale(result.data.stale);
        setSnapshot(result.data.snapshot ?? null);
      } else {
        setError(result.error.message);
      }
    },
    []
  );

  // Sort and feature changes are instant; typing is debounced so the live
  // Hugging Face search is not called on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      void loadCatalogue(search, sort, capability, supportedOnly);
    }, search.length > 0 ? 400 : 0);

    return () => clearTimeout(timer);
  }, [capability, loadCatalogue, search, sort, supportedOnly]);

  useEffect(() => {
    void reloadSessions();
    const timer = setInterval(() => {
      // A hidden window has nothing to update; wake up on the next visibility change.
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }

      void reloadSessions();
    }, 5_000);

    const onVisible = (): void => {
      if (!document.hidden) {
        void reloadSessions();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reloadSessions]);

  const reloadUseCases = useCallback(async () => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    const result = await bridge.invoke<UseCaseCard[]>("catalogue.useCases");
    if (result.ok) {
      setUseCases(result.data);
      // No curated cards means this deployment is advanced-only.
      if (result.data.length === 0 && mode === "basic") {
        setMode("advanced");
      }
    }
  }, [mode, setMode]);

  useEffect(() => {
    void reloadUseCases();
  }, [reloadUseCases]);

  const refreshCatalogue = useCallback(async () => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    setLoadingCatalogue(true);
    const result = await bridge.invoke<CatalogueResult>("catalogue.refresh");
    setLoadingCatalogue(false);

    if (result.ok) {
      await loadCatalogue(search, sort, capability, supportedOnly);
    } else {
      setError(result.error.message);
    }
  }, [capability, loadCatalogue, search, sort, supportedOnly]);

  const selectModel = useCallback(async (id: string) => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    setSelected(null);
    const result = await bridge.invoke<ModelDetail>("catalogue.detail", { id });

    if (result.ok) {
      setSelected(result.data);
    } else {
      setError(result.error.message);
    }
  }, []);

  const prepareEstimate = useCallback(async (modelId: string, powerTier?: PowerTier) => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    setPreparing(true);
    const result = await bridge.invoke<Estimate>("estimate.create", {
      modelId,
      ...(powerTier ? { powerTier } : {}),
      expectedMinutes: 30
    });
    setPreparing(false);

    if (result.ok) {
      setEstimates((current) => ({ ...current, [modelId]: result.data }));
      setError(null);
    } else {
      setError(result.error.message);
    }
  }, []);

  const startSession = useCallback(
    async (modelId: string, confirmGatedAccess = false) => {
      const bridge = window.maia;
      const estimate = estimates[modelId];
      if (!bridge || !estimate) {
        return null;
      }

      if (
        sessions.some(
          (session) =>
            session.modelId === modelId &&
            (session.state === "provisioning" || session.state === "ready" || session.state === "active")
        )
      ) {
        setError(`${modelId} already has a running session. Open it from the chat list instead.`);
        return null;
      }

      setStartingIds((current) => (current.includes(modelId) ? current : [...current, modelId]));
      const result = await bridge.invoke<Session>("session.start", {
        estimateId: estimate.id,
        confirmEstimate: true,
        confirmGatedAccess
      });
      setStartingIds((current) => current.filter((id) => id !== modelId));

      if (result.ok) {
        // The estimate is consumed by the booking, and the session keeps booting
        // in the background while other models can be started.
        setEstimates((current) => {
          const next = { ...current };
          delete next[modelId];
          return next;
        });
        setError(null);
        await reloadSessions();
        setFocusSessionId(result.data.id);
        return result.data;
      }

      setError(result.error.message);
      return null;
    },
    [estimates, reloadSessions, sessions]
  );

  const value = useMemo<WorkspaceValue>(
    () => ({
      models,
      stale,
      loadingCatalogue,
      snapshot,
      search,
      setSearch,
      sort,
      setSort,
      capability,
      setCapability,
      supportedOnly,
      setSupportedOnly,
      mode,
      setMode,
      useCases,
      reloadUseCases,
      refreshCatalogue,
      selectModel,
      selected,
      estimates,
      preparing,
      sessions,
      startingIds,
      focusSessionId,
      clearFocusSession: () => setFocusSessionId(null),
      error,
      clearError: () => setError(null),
      prepareEstimate,
      startSession,
      reloadSessions
    }),
    [
      capability,
      error,
      estimates,
      focusSessionId,
      loadingCatalogue,
      models,
      prepareEstimate,
      preparing,
      refreshCatalogue,
      reloadSessions,
      search,
      selectModel,
      selected,
      sessions,
      snapshot,
      sort,
      startSession,
      startingIds,
      stale,
      supportedOnly,
      mode,
      useCases,
      reloadUseCases
    ]
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);

  if (!value) {
    throw new Error("useWorkspace must be used inside a WorkspaceProvider");
  }

  return value;
}

/** Session lists are small; comparing them is cheaper than a full re-render. */
function sameSessions(left: Session[], right: Session[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.id !== b.id ||
      a.state !== b.state ||
      a.events.length !== b.events.length ||
      a.readyAt !== b.readyAt ||
      a.instanceId !== b.instanceId
    ) {
      return false;
    }
  }

  return true;
}
