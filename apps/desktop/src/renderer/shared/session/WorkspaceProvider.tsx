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
  CatalogueSort,
  Estimate,
  ModelDetail,
  Session
} from "@maia/contracts";

interface WorkspaceValue {
  models: CatalogueModel[];
  stale: boolean;
  loadingCatalogue: boolean;
  search: string;
  setSearch(value: string): void;
  sort: CatalogueSort;
  setSort(value: CatalogueSort): void;
  capability: string;
  setCapability(value: string): void;
  refreshCatalogue(): Promise<void>;
  selectModel(id: string): Promise<void>;
  selected: ModelDetail | null;
  estimate: Estimate | null;
  preparing: boolean;
  sessions: Session[];
  starting: boolean;
  error: string | null;
  clearError(): void;
  prepareEstimate(modelId: string): Promise<void>;
  startSession(): Promise<Session | null>;
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
  const [selected, setSelected] = useState<ModelDetail | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadSessions = useCallback(async () => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    const result = await bridge.invoke<Session[]>("session.list");
    if (result.ok) {
      setSessions(result.data);
    }
  }, []);

  const loadCatalogue = useCallback(
    async (term: string, order: CatalogueSort, feature: string) => {
      const bridge = window.maia;
      if (!bridge) {
        return;
      }

      setLoadingCatalogue(true);
      const result = await bridge.invoke<CatalogueResult>("catalogue.search", {
        search: term || undefined,
        sort: order,
        capability: feature || undefined,
        limit: 100
      });
      setLoadingCatalogue(false);

      if (result.ok) {
        setModels(result.data.models);
        setStale(result.data.stale);
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
      void loadCatalogue(search, sort, capability);
    }, search.length > 0 ? 400 : 0);

    return () => clearTimeout(timer);
  }, [capability, loadCatalogue, search, sort]);

  useEffect(() => {
    void reloadSessions();
    const timer = setInterval(() => void reloadSessions(), 5_000);
    return () => clearInterval(timer);
  }, [reloadSessions]);

  const refreshCatalogue = useCallback(async () => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    setLoadingCatalogue(true);
    const result = await bridge.invoke<CatalogueResult>("catalogue.refresh");
    setLoadingCatalogue(false);

    if (result.ok) {
      await loadCatalogue(search, sort, capability);
    } else {
      setError(result.error.message);
    }
  }, [capability, loadCatalogue, search, sort]);

  const selectModel = useCallback(async (id: string) => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    setSelected(null);
    setEstimate(null);
    const result = await bridge.invoke<ModelDetail>("catalogue.detail", { id });

    if (result.ok) {
      setSelected(result.data);
    } else {
      setError(result.error.message);
    }
  }, []);

  const prepareEstimate = useCallback(async (modelId: string) => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    setPreparing(true);
    const result = await bridge.invoke<Estimate>("estimate.create", {
      modelId,
      expectedMinutes: 30
    });
    setPreparing(false);

    if (result.ok) {
      setEstimate(result.data);
      setError(null);
    } else {
      setError(result.error.message);
    }
  }, []);

  const startSession = useCallback(async () => {
    const bridge = window.maia;
    if (!bridge || !estimate) {
      return null;
    }

    setStarting(true);
    const result = await bridge.invoke<Session>("session.start", {
      estimateId: estimate.id,
      confirmEstimate: true
    });
    setStarting(false);

    if (result.ok) {
      setEstimate(null);
      setError(null);
      await reloadSessions();
      return result.data;
    }

    setError(result.error.message);
    return null;
  }, [estimate, reloadSessions]);

  const value = useMemo<WorkspaceValue>(
    () => ({
      models,
      stale,
      loadingCatalogue,
      search,
      setSearch,
      sort,
      setSort,
      capability,
      setCapability,
      refreshCatalogue,
      selectModel,
      selected,
      estimate,
      preparing,
      sessions,
      starting,
      error,
      clearError: () => setError(null),
      prepareEstimate,
      startSession,
      reloadSessions
    }),
    [
      capability,
      error,
      estimate,
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
      sort,
      startSession,
      starting,
      stale
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
