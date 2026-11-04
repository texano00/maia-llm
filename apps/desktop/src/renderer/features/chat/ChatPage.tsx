import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  ConversationDetail,
  ConversationSummary,
  Estimate,
  Session
} from "@maia/contracts";
import { useWorkspace } from "../../shared/session/WorkspaceProvider";
import { accruedMicroUsd, formatElapsed, formatUsd } from "../../shared/format";

interface StreamingBubble {
  reasoning: string;
  content: string;
}

export function ChatPage() {
  const {
    sessions,
    reloadSessions,
    focusSessionId,
    clearFocusSession,
    error: workspaceError,
    clearError
  } = useWorkspace();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState<StreamingBubble | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const transcriptRef = useRef<HTMLDivElement>(null);
  // Event transports can deliver the last deltas after the send resolves; those
  // must not paint a second bubble over the stored transcript.
  const inFlightRef = useRef(false);

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const frozen =
    detail !== null && detail.conversation.modelId !== null && !sessions.some((session) => session.modelId === detail.conversation.modelId);

  const loadConversations = useCallback(async () => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    const result = await bridge.invoke<ConversationSummary[]>("conversation.list", { limit: 100 });
    if (result.ok) {
      setConversations(result.data);
    }
  }, []);

  const openConversation = useCallback(
    async (id: string) => {
      const bridge = window.maia;
      if (!bridge) {
        return;
      }

      setActiveConversationId(id);
      setStreaming(null);
      const result = await bridge.invoke<ConversationDetail>("conversation.get", { id });

      if (result.ok) {
        setDetail(result.data);
        const match = sessions.find((session) => session.modelId === result.data.conversation.modelId);
        setActiveSessionId(match?.id ?? null);
      } else {
        setError(result.error.message);
      }
    },
    [sessions]
  );

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // Starting a model from the catalogue lands here: select that session so the
  // composer is usable straight away instead of asking for a new chat.
  useEffect(() => {
    if (!focusSessionId) {
      return;
    }

    if (sessions.some((session) => session.id === focusSessionId)) {
      setActiveSessionId(focusSessionId);
      clearFocusSession();
    }
  }, [clearFocusSession, focusSessionId, sessions]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    return bridge.onChatEvent((chunk) => {
      if (chunk.conversationId !== activeConversationId || !inFlightRef.current) {
        return;
      }

      if (chunk.done) {
        setStreaming((current) => {
          if (current) {
            setDetail((existing) =>
              existing
                ? {
                    ...existing,
                    messages: [
                      ...existing.messages,
                      {
                        id: `assistant-${Date.now()}`,
                        role: "assistant",
                        content: current.content,
                        createdAt: new Date().toISOString()
                      }
                    ]
                  }
                : existing
            );
          }
          return null;
        });
        setBusy(false);
        void loadConversations();
        return;
      }

      setStreaming((current) => {
        const next = current ?? { reasoning: "", content: "" };
        return chunk.kind === "reasoning"
          ? { ...next, reasoning: next.reasoning + chunk.delta }
          : { ...next, content: next.content + chunk.delta };
      });
    });
  }, [activeConversationId, loadConversations]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [detail?.messages.length, streaming?.content]);

  async function togglePinned(conversation: ConversationSummary): Promise<void> {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    const result = await bridge.invoke("conversation.setPinned", {
      id: conversation.id,
      pinned: !conversation.pinned
    });

    if (result.ok) {
      await loadConversations();
    } else {
      setError(result.error.message);
    }
  }

  async function commitRename(id: string): Promise<void> {
    const bridge = window.maia;
    const title = renameDraft.trim();
    setRenamingId(null);

    if (!bridge || title.length === 0) {
      return;
    }

    const result = await bridge.invoke("conversation.rename", { id, title });

    if (result.ok) {
      await loadConversations();
      if (id === activeConversationId) {
        setDetail((current) =>
          current ? { ...current, conversation: { ...current.conversation, title } } : current
        );
      }
    } else {
      setError(result.error.message);
    }
  }

  function startNewChat(): void {
    setCreating(true);
    setActiveConversationId(null);
    setDetail(null);
    setStreaming(null);
    setActiveSessionId(sessions[0]?.id ?? null);
    setDraft("");
  }

  async function send(): Promise<void> {
    const bridge = window.maia;
    const content = draft.trim();
    if (!bridge || !content || !activeSession) {
      return;
    }

    setDraft("");
    setBusy(true);
    inFlightRef.current = true;
    setError(null);
    setDetail((existing) =>
      existing
        ? {
            ...existing,
            messages: [
              ...existing.messages,
              {
                id: `user-${Date.now()}`,
                role: "user",
                content,
                createdAt: new Date().toISOString()
              }
            ]
          }
        : existing
    );
    setStreaming({ reasoning: "", content: "" });

    const result = await bridge.invoke<{ conversationId: string }>("chat.send", {
      sessionId: activeSession.id,
      conversationId: activeConversationId ?? undefined,
      content
    });

    if (!result.ok) {
      setBusy(false);
      inFlightRef.current = false;
      setStreaming(null);
      setError(result.error.message);
      return;
    }

    if (!activeConversationId) {
      setActiveConversationId(result.data.conversationId);
      setCreating(false);
      await loadConversations();
    }

    // The first message creates the conversation, so the stored transcript has to
    // be loaded — otherwise the reply streams into a view that never renders it.
    const loaded = await bridge.invoke<ConversationDetail>("conversation.get", {
      id: activeConversationId ?? result.data.conversationId
    });
    if (loaded.ok) {
      setDetail(loaded.data);
      setStreaming(null);
    }

    inFlightRef.current = false;
    setBusy(false);
  }

  async function switchModel(session: Session): Promise<void> {
    const bridge = window.maia;
    if (!bridge || !activeConversationId) {
      setActiveSessionId(session.id);
      return;
    }

    const confirmed = window.confirm(
      `Continue this conversation with ${session.modelId}?\n\nThe chat will show a switch note, and earlier replies stay attributed to the previous model.`
    );
    if (!confirmed) {
      return;
    }

    const result = await bridge.invoke<ConversationDetail>("conversation.switchModel", {
      conversationId: activeConversationId,
      sessionId: session.id,
      confirm: true
    });

    if (result.ok) {
      setDetail(result.data);
      setActiveSessionId(session.id);
      await loadConversations();
    } else {
      setError(result.error.message);
    }
  }

  async function reviveModel(modelId: string): Promise<void> {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    setBusy(true);
    const estimate = await bridge.invoke<Estimate>("estimate.create", {
      modelId,
      expectedMinutes: 30
    });

    if (!estimate.ok) {
      setBusy(false);
      setError(estimate.error.message);
      return;
    }

    const confirmed = window.confirm(
      `Start ${estimate.data.gpuName} at ${formatUsd(estimate.data.hourlyRateMicroUsd)}/h?\n\nExpected 30 min cost: ${formatUsd(estimate.data.projectedTotalMicroUsd)} (range ${formatUsd(estimate.data.rangeMicroUsd.low)}–${formatUsd(estimate.data.rangeMicroUsd.high)}).`
    );

    if (!confirmed) {
      setBusy(false);
      return;
    }

    const started = await bridge.invoke<Session>("session.start", {
      estimateId: estimate.data.id,
      confirmEstimate: true
    });
    setBusy(false);

    if (started.ok) {
      await reloadSessions();
      setActiveSessionId(started.data.id);
      setError(null);
    } else {
      setError(started.error.message);
    }
  }

  const showError = error ?? workspaceError;

  return (
    <section className="chat-layout">
      <aside className="chat-history" aria-label="Chat history">
        <div className="chat-history-head">
          <strong>Chats</strong>
          <button type="button" className="ghost-button" onClick={startNewChat}>
            New
          </button>
        </div>
        <ul>
          {conversations.length === 0 ? <li className="muted small">No conversations yet.</li> : null}
          {conversations.map((conversation) => (
            <li key={conversation.id} className="history-row">
              {renamingId === conversation.id ? (
                <input
                  className="history-rename"
                  autoFocus
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={() => void commitRename(conversation.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void commitRename(conversation.id);
                    }
                    if (event.key === "Escape") {
                      setRenamingId(null);
                    }
                  }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    className={
                      conversation.id === activeConversationId && !creating
                        ? "history-item selected"
                        : "history-item"
                    }
                    onClick={() => {
                      setCreating(false);
                      void openConversation(conversation.id);
                    }}
                    onDoubleClick={() => {
                      setRenamingId(conversation.id);
                      setRenameDraft(conversation.title);
                    }}
                  >
                    <span className="history-title">
                      {conversation.pinned ? "★ " : ""}
                      {conversation.title}
                    </span>
                    <span className="history-meta">
                      {conversation.modelId ?? "unknown model"}
                      {conversation.frozen ? " · frozen" : ""}
                    </span>
                  </button>
                  <div className="history-actions">
                    <button
                      type="button"
                      className="icon-mini"
                      title={conversation.pinned ? "Unpin chat" : "Pin chat"}
                      aria-label={conversation.pinned ? "Unpin chat" : "Pin chat"}
                      onClick={() => void togglePinned(conversation)}
                    >
                      {conversation.pinned ? "★" : "☆"}
                    </button>
                    <button
                      type="button"
                      className="icon-mini"
                      title="Rename chat"
                      aria-label="Rename chat"
                      onClick={() => {
                        setRenamingId(conversation.id);
                        setRenameDraft(conversation.title);
                      }}
                    >
                      ✎
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </aside>

      <div className="chat-main">
        <div className="session-bar">
          <label className="inline-field">
            <span>Model</span>
            <select
              value={activeSessionId ?? ""}
              onChange={(event) => {
                const session = sessions.find((entry) => entry.id === event.target.value);
                if (session) {
                  void switchModel(session);
                }
                if (!event.target.value) {
                  setActiveSessionId(null);
                }
              }}
            >
              <option value="">
                {sessions.length === 0 ? "No model running" : "Select a running model"}
              </option>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.modelId} · {session.gpuName}
                </option>
              ))}
            </select>
          </label>

          {activeSession ? (
            <>
              <span className={stateClass(activeSession.state)}>{stateLabel(activeSession.state)}</span>
              <span className="pill">{formatUsd(activeSession.hourlyRateMicroUsd)}/h</span>
              <span className="pill">elapsed {formatElapsed(activeSession.startedAt, now)}</span>
              <span className="pill">
                accrued {formatUsd(accruedMicroUsd(activeSession.hourlyRateMicroUsd, activeSession.startedAt, now))}
              </span>
              <button
                type="button"
                className="ghost-button"
                onClick={async () => {
                  const bridge = window.maia;
                  if (!bridge) {
                    return;
                  }
                  await bridge.invoke("session.end", {
                    sessionId: activeSession.id,
                    reason: "user"
                  });
                  setActiveSessionId(null);
                  await reloadSessions();
                }}
              >
                Pause and release GPU
              </button>
            </>
          ) : null}
        </div>

        {activeSession ? (
          <details className="session-log" open={activeSession.state === "provisioning"}>
            <summary>
              Provisioning log · {activeSession.events.length} events
              {activeSession.instanceId ? ` · instance ${activeSession.instanceId}` : ""}
            </summary>
            <ol>
              {activeSession.events.length === 0 ? (
                <li className="muted small">No events yet.</li>
              ) : null}
              {activeSession.events.map((event, index) => (
                <li key={`${event.at}-${index}`} className={`log-${event.level}`}>
                  <time dateTime={event.at}>{formatClock(event.at)}</time>
                  <span className="log-level">{event.level}</span>
                  <span>{event.message}</span>
                </li>
              ))}
            </ol>
          </details>
        ) : null}

        {showError ? (
          <div className="alert" role="alert">
            <span>{showError}</span>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                setError(null);
                clearError();
              }}
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {frozen && detail?.conversation.modelId ? (
          <div className="alert alert-frozen" role="status">
            <div>
              <strong>This chat is frozen.</strong>{" "}
              {detail.conversation.modelId} is not running any more. Restart it to continue where you
              left off, or switch this conversation to another running model.
            </div>
            <div className="update-actions">
              <button type="button" disabled={busy} onClick={() => void reviveModel(detail.conversation.modelId!)}>
                {busy ? "Starting…" : `Restart ${shortModel(detail.conversation.modelId)}`}
              </button>
              {sessions.length > 0 ? (
                <select
                  defaultValue=""
                  onChange={(event) => {
                    const session = sessions.find((entry) => entry.id === event.target.value);
                    if (session) {
                      void switchModel(session);
                    }
                  }}
                >
                  <option value="" disabled>
                    Continue with another model…
                  </option>
                  {sessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.modelId}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="transcript" ref={transcriptRef}>
          {creating && detail === null ? (
            <div className="new-chat">
              <h3>Start a new conversation</h3>
              {sessions.length === 0 ? (
                <>
                  <p className="muted">
                    No model is running. Start one from the catalogue — pick a model, review the
                    price, and run it — then come back here.
                  </p>
                  <Link className="nav-link active" to="/catalogue">
                    Open the catalogue
                  </Link>
                </>
              ) : (
                <p className="muted">
                  Choose one of the running models in the selector above, then send the first
                  message. The conversation appears in the list on the left.
                </p>
              )}
            </div>
          ) : null}

          {detail === null && !creating ? (
            <p className="muted">Pick a chat on the left, or start one with New.</p>
          ) : null}
          {detail?.messages.map((message) => (
            <article key={message.id} className={`bubble bubble-${message.role}`}>
              <header>{roleLabel(message.role)}</header>
              <p>{message.content}</p>
            </article>
          ))}
          {streaming ? (
            <>
              {streaming.reasoning ? (
                <details className="bubble bubble-reasoning" open>
                  <summary>Thinking…</summary>
                  <p>{streaming.reasoning}</p>
                </details>
              ) : null}
              <article className="bubble bubble-assistant">
                <header>Model</header>
                <p>{streaming.content || "…"}</p>
              </article>
            </>
          ) : null}
        </div>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            rows={3}
            value={draft}
            placeholder={
              activeSession
                ? activeSession.state === "active"
                  ? "Ask the model something…"
                  : `Model is ${stateLabel(activeSession.state).toLowerCase()} — the composer unlocks when it is running.`
                : frozen
                  ? "Restart the model or switch models to continue this chat."
                  : "Start a model from the catalogue to chat."
            }
            disabled={!activeSession || activeSession.state !== "active" || busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="update-actions">
            <button type="submit" disabled={!activeSession || activeSession.state !== "active" || busy || draft.trim().length === 0}>
              {busy ? "Generating…" : "Send"}
            </button>
            {busy && activeSession ? (
              <button
                type="button"
                className="ghost-button"
                onClick={async () => {
                  await window.maia?.invoke("chat.abort", { sessionId: activeSession.id });
                }}
              >
                Stop
              </button>
            ) : null}
            {!activeSession && !frozen ? (
              <Link className="ghost-button" to="/catalogue">
                Choose a model
              </Link>
            ) : null}
          </div>
        </form>
      </div>
    </section>
  );
}

function shortModel(modelId: string): string {
  return modelId.split("/").at(-1) ?? modelId;
}

const STATE_LABELS: Record<string, string> = {
  estimated: "Estimated",
  provisioning: "Provisioning",
  ready: "Starting",
  active: "Running",
  ending: "Shutting down",
  ended: "Paused",
  cancelled: "Cancelled",
  failed: "Error"
};

function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

function stateClass(state: string): string {
  if (state === "active") {
    return "pill pill-ok";
  }
  if (state === "failed") {
    return "pill pill-danger";
  }
  if (state === "provisioning" || state === "ready" || state === "ending") {
    return "pill pill-warning";
  }
  return "pill";
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function roleLabel(role: string): string {
  switch (role) {
    case "user":
      return "You";
    case "assistant":
      return "Model";
    case "system":
      return "Notice";
    default:
      return role;
  }
}
