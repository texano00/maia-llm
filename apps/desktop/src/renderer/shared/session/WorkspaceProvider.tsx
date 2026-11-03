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
  Estimate,
  ModelDetail,
  Session
} from "@maia/contracts";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming: boolean;
  tokens?: number | undefined;
}

interface WorkspaceValue {
  models: CatalogueModel[];
  stale: boolean;
  loadingCatalogue: boolean;
  search: string;
  setSearch(value: string): void;
  refreshCatalogue(): Promise<void>;
  selectModel(id: string): Promise<void>;
  selected: ModelDetail | null;
  estimate: Estimate | null;
  preparing: boolean;
  session: Session | null;
  starting: boolean;
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
  clearError(): void;
  prepareEstimate(modelId: string): Promise<void>;
  startSession(): Promise<boolean>;
  sendMessage(content: string): Promise<void>;
  abort(): Promise<void>;
  endSession(): Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

/**
 * Owns the MVP flow state: catalogue → detail → estimate → session → chat.
 * Every IPC failure surfaces as `error` so the UI can explain what happened.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [models, setModels] = useState<CatalogueModel[]>([]);
  const [stale, setStale] = useState(false);
  const [loadingCatalogue, setLoadingCatalogue] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ModelDetail | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [starting, setStarting] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCatalogue = useCallback(async (query: string) => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    setLoadingCatalogue(true);
    const result = await bridge.invoke<CatalogueResult>("catalogue.search", {
      search: query || undefined,
      sort: "downloads",
      limit: 50
    });
    setLoadingCatalogue(false);

    if (result.ok) {
      setModels(result.data.models);
      setStale(result.data.stale);
    } else {
      setError(result.error.message);
    }
  }, []);

  useEffect(() => {
    void loadCatalogue("");
  }, [loadCatalogue]);

  useEffect(() => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    void bridge.invoke<Session | null>("session.status").then((result) => {
      if (result.ok) {
        setSession(result.data);
      }
    });

    const unsubscribe = bridge.onChatEvent((chunk) => {
      setMessages((current) => {
        const last = current.at(-1);
        if (!last || last.role !== "assistant" || !last.streaming) {
          return current;
        }

        const updated: ChatMessage = {
          ...last,
          content: last.content + chunk.delta,
          streaming: !chunk.done,
          tokens: chunk.tokens ?? last.tokens
        };

        return [...current.slice(0, -1), updated];
      });

      if (chunk.done) {
        setStreaming(false);
      }
    });

    return unsubscribe;
  }, []);

  const refreshCatalogue = useCallback(async () => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    setLoadingCatalogue(true);
    const result = await bridge.invoke<CatalogueResult>("catalogue.refresh");
    setLoadingCatalogue(false);

    if (result.ok) {
      setModels(result.data.models);
      setStale(result.data.stale);
    } else {
      setError(result.error.message);
    }
  }, []);

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
      return false;
    }

    setStarting(true);
    const result = await bridge.invoke<Session>("session.start", {
      estimateId: estimate.id,
      confirmEstimate: true
    });
    setStarting(false);

    if (result.ok) {
      setSession(result.data);
      setMessages([]);
      setError(null);
      return true;
    }

    setError(result.error.message);
    return false;
  }, [estimate]);

  const sendMessage = useCallback(
    async (content: string) => {
      const bridge = window.maia;
      if (!bridge || !session) {
        return;
      }

      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content,
        streaming: false
      };
      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: "",
        streaming: true
      };

      setMessages((current) => [...current, userMessage, assistantMessage]);
      setStreaming(true);

      const result = await bridge.invoke<{ tokens: number }>("chat.send", {
        sessionId: session.id,
        content
      });

      if (!result.ok) {
        setStreaming(false);
        setError(result.error.message);
      }
    },
    [session]
  );

  const abort = useCallback(async () => {
    const bridge = window.maia;
    if (!bridge || !session) {
      return;
    }

    await bridge.invoke("chat.abort", { sessionId: session.id });
    setStreaming(false);
  }, [session]);

  const endSession = useCallback(async () => {
    const bridge = window.maia;
    if (!bridge || !session) {
      return;
    }

    const result = await bridge.invoke<Session | null>("session.end", {
      sessionId: session.id,
      reason: "user"
    });

    if (result.ok) {
      setSession(null);
      setEstimate(null);
      setMessages([]);
    } else {
      setError(result.error.message);
    }
  }, [session]);

  const value = useMemo<WorkspaceValue>(
    () => ({
      models,
      stale,
      loadingCatalogue,
      search,
      setSearch,
      refreshCatalogue,
      selectModel,
      selected,
      estimate,
      preparing,
      session,
      starting,
      messages,
      streaming,
      error,
      clearError: () => setError(null),
      prepareEstimate,
      startSession,
      sendMessage,
      abort,
      endSession
    }),
    [
      abort,
      endSession,
      error,
      estimate,
      loadingCatalogue,
      messages,
      models,
      prepareEstimate,
      preparing,
      refreshCatalogue,
      search,
      selected,
      sendMessage,
      session,
      stale,
      startSession,
      starting,
      streaming
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
