import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  ConversationDetail,
  ConversationSummary,
  Estimate,
  Session
} from "@maia/contracts";
import { useWorkspace } from "../../shared/session/WorkspaceProvider";
import { accruedMicroUsd, formatElapsed, formatUsd } from "../../shared/format";
import { MessageContent } from "./MessageContent";
import { ReasoningPanel } from "./ReasoningPanel";

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
  // First turn of a new chat: the transcript does not exist yet, so the user's
  // own message is echoed from here until the stored conversation loads.
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [studentMode, setStudentMode] = useState(readStudentMode);
  const [historyOpen, setHistoryOpen] = useState(readHistoryOpen);
  const [atBottom, setAtBottom] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const transcriptRef = useRef<HTMLDivElement>(null);
  // Streaming must not yank the transcript back to the bottom: scrolling up to
  // re-read an earlier step has to stay possible until the user returns.
  const stickToBottomRef = useRef(true);
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
      rememberConversation(id);
      setStreaming(null);
      const result = await bridge.invoke<ConversationDetail>("conversation.get", { id });

      if (result.ok) {
        setDetail(result.data);
        const match = sessions.find((session) => session.modelId === result.data.conversation.modelId);
        setActiveSessionId(match?.id ?? null);
      } else if (result.error.code === "NOT_FOUND") {
        // The remembered chat was deleted, or belonged to a different install:
        // forget it quietly instead of alerting on every visit to the page.
        rememberConversation(null);
        setActiveConversationId(null);
        setDetail(null);
        void loadConversations();
      } else {
        setError(result.error.message);
      }
    },
    [loadConversations, sessions]
  );

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // Routes are lazily loaded, so coming back to the chat remounts this component.
  // Runs once on mount: afterwards the user's own navigation wins.
  useEffect(() => {
    const last = recallConversation();
    if (last) {
      void openConversation(last);
    }
  }, []);

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
    // The elapsed/cost clock only matters while a session is running. Ticking
    // otherwise re-rendered the whole transcript every second for nothing.
    const live = sessions.some(
      (session) => session.state === "active" || session.state === "provisioning"
    );
    if (!live) {
      return;
    }

    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sessions]);

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
                        reasoning: current.reasoning.length > 0 ? current.reasoning : null,
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
    if (!stickToBottomRef.current) {
      return;
    }

    const element = transcriptRef.current;
    // `auto` rather than `smooth`: a smooth scroll restarted on every delta makes
    // the transcript stutter while the model is talking.
    element?.scrollTo({ top: element.scrollHeight });
  }, [detail?.messages.length, streaming?.content, streaming?.reasoning, studentMode]);

  // Reasoning opens, paced text grows, code blocks mount: content changes that no
  // dependency above notices. While the reader is at the bottom, follow it.
  useEffect(() => {
    const element = transcriptRef.current;
    if (!element || typeof MutationObserver === "undefined") {
      return;
    }

    const observer = new MutationObserver(() => {
      if (stickToBottomRef.current) {
        element.scrollTo({ top: element.scrollHeight });
      }
    });
    observer.observe(element, { childList: true, subtree: true, characterData: true });

    return () => observer.disconnect();
  }, []);

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

  /** Permanent, with a confirmation that names the conversation. */
  async function deleteConversation(conversation: ConversationSummary): Promise<void> {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    if (!window.confirm(`Delete "${conversation.title}"? This cannot be undone.`)) {
      return;
    }

    const result = await bridge.invoke("conversation.delete", { id: conversation.id });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }

    if (conversation.id === activeConversationId) {
      startNewChat();
    }

    await loadConversations();
  }

  async function commitRename(id: string): Promise<void> {    const bridge = window.maia;
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
    rememberConversation(null);
    setDetail(null);
    setStreaming(null);
    setPendingUser(null);
    setActiveSessionId(sessions[0]?.id ?? null);
    setDraft("");
  }

  function toggleHistory(): void {
    const next = !historyOpen;
    setHistoryOpen(next);
    writeHistoryOpen(next);
  }

  function handleTranscriptScroll(): void {
    const element = transcriptRef.current;
    if (!element) {
      return;
    }

    // 48 px of slack: a reader who scrolled a line up still counts as "at the
    // bottom", otherwise one wheel notch would stop the follow for good.
    const stuck = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    stickToBottomRef.current = stuck;
    setAtBottom((current) => (current === stuck ? current : stuck));
  }

  function jumpToLatest(): void {
    const element = transcriptRef.current;
    stickToBottomRef.current = true;
    setAtBottom(true);
    element?.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
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
    setPendingUser(activeConversationId ? null : content);
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
                reasoning: null,
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
      rememberConversation(result.data.conversationId);
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
      setPendingUser(null);
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
    <section className={historyOpen ? "chat-layout" : "chat-layout history-collapsed"}>
      <aside className={historyOpen ? "chat-history" : "chat-history rail"} aria-label="Chat history">
        {historyOpen ? (
          <>
            <div className="chat-history-head">
              <strong>Chats</strong>
              <div className="history-head-actions">
                <button type="button" className="ghost-button" onClick={startNewChat}>
                  New
                </button>
                <button
                  type="button"
                  className="icon-mini"
                  title="Collapse chats"
                  aria-label="Collapse chats"
                  aria-expanded={true}
                  onClick={toggleHistory}
                >
                  «
                </button>
              </div>
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
                    <button
                      type="button"
                      className="icon-mini"
                      title="Delete chat"
                      aria-label="Delete chat"
                      onClick={() => void deleteConversation(conversation)}
                    >
                      🗑
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
            </ul>
          </>
        ) : (
          <div className="history-rail-actions">
            <button
              type="button"
              className="icon-mini"
              title="Show chats"
              aria-label="Show chats"
              aria-expanded={false}
              onClick={toggleHistory}
            >
              ☰
            </button>
            <button
              type="button"
              className="icon-mini"
              title="New chat"
              aria-label="New chat"
              onClick={startNewChat}
            >
              ＋
            </button>
          </div>
        )}
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

          <label className="inline-field reasoning-toggle" title="Show the model's thinking, revealed at a reading pace">
            <input
              type="checkbox"
              checked={studentMode}
              onChange={(event) => {
                const next = event.target.checked;
                setStudentMode(next);
                writeStudentMode(next);
              }}
            />
            <span>Student mode</span>
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

        <div className="transcript-wrap">
          <div className="transcript" ref={transcriptRef} onScroll={handleTranscriptScroll}>
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

          {detail === null && !creating && !busy ? (
            <p className="muted">Pick a chat on the left, or start one with New.</p>
          ) : null}
          {detail?.messages.map((message) => (
            <MessageBubble
              key={message.id}
              role={message.role}
              content={message.content}
              reasoning={message.reasoning}
              studentMode={studentMode}
            />
          ))}
          {detail === null && pendingUser ? (
            <article className="bubble bubble-user">
              <header>You</header>
              <p>{pendingUser}</p>
            </article>
          ) : null}
          {streaming ? (
            <>
              {streaming.reasoning ? (
                <ReasoningPanel
                  text={streaming.reasoning}
                  streaming
                  studentMode={studentMode}
                  variant="bubble"
                />
              ) : null}
              <article className="bubble bubble-assistant">
                <header>Model</header>
                {streaming.content ? (
                  <MessageContent text={streaming.content} streaming />
                ) : (
                  <p className="muted">{streaming.reasoning ? "Thinking…" : "…"}</p>
                )}
              </article>
            </>
          ) : null}
          </div>
          {!atBottom ? (
            <button type="button" className="jump-latest" onClick={jumpToLatest}>
              Jump to latest ↓
            </button>
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

/** Memoised so the one-second clock tick does not re-render every old message. */
const MessageBubble = memo(function MessageBubble({
  role,
  content,
  reasoning,
  studentMode
}: {
  role: string;
  content: string;
  reasoning?: string | null;
  studentMode: boolean;
}) {
  return (
    <article className={`bubble bubble-${role}`}>
      <header>{roleLabel(role)}</header>
      {reasoning ? (
        <ReasoningPanel text={reasoning} streaming={false} studentMode={studentMode} variant="inline" />
      ) : null}
      <MessageContent text={content} />
    </article>
  );
});

const LAST_CONVERSATION_KEY = "maia:last-conversation";
const STUDENT_MODE_KEY = "maia:student-mode";
const LEGACY_REASONING_KEY = "maia:show-reasoning";
const HISTORY_OPEN_KEY = "maia:history-open";

/**
 * Student mode: open the reasoning panel and reveal it at a human reading pace.
 * Off by default — the thinking of a reasoning model is long, and most answers do
 * not need it.
 */
function readStudentMode(): boolean {
  try {
    const stored = window.localStorage.getItem(STUDENT_MODE_KEY);
    if (stored !== null) {
      return stored === "true";
    }

    // Carries over the previous "Show reasoning" preference.
    return window.localStorage.getItem(LEGACY_REASONING_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStudentMode(value: boolean): void {
  try {
    window.localStorage.setItem(STUDENT_MODE_KEY, value ? "true" : "false");
  } catch {
    // Storage can be unavailable; the toggle still works for this session.
  }
}

/** The chat list is open by default; on a narrow window it can be collapsed. */
function readHistoryOpen(): boolean {
  try {
    return window.localStorage.getItem(HISTORY_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeHistoryOpen(value: boolean): void {
  try {
    window.localStorage.setItem(HISTORY_OPEN_KEY, value ? "true" : "false");
  } catch {
    // Storage can be unavailable; collapsing still works for this session.
  }
}

function rememberConversation(id: string | null): void {
  try {
    if (id === null) {
      window.localStorage.removeItem(LAST_CONVERSATION_KEY);
      return;
    }

    window.localStorage.setItem(LAST_CONVERSATION_KEY, id);
  } catch {
    // Storage can be unavailable; reopening the chat is a convenience only.
  }
}

function recallConversation(): string | null {
  try {
    return window.localStorage.getItem(LAST_CONVERSATION_KEY);
  } catch {
    return null;
  }
}
