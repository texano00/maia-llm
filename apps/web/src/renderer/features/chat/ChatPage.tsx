import { Link } from "react-router-dom";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatImage,
  ChatTurnResult,
  ConversationDetail,
  ConversationSummary,
  RuntimeConfig,
  Session
} from "@maia/contracts";
import { useWorkspace } from "../../shared/session/WorkspaceProvider";
import { useUiPreferences } from "../../shared/preferences/useUiPreferences";
import { updatePreferences } from "../../shared/preferences/store";
import { usePhoneLayout } from "../../shared/useMediaQuery";
import { useKeyboardInset } from "../../shared/useKeyboardInset";
import { MessageContent } from "./MessageContent";
import { ReasoningPanel } from "./ReasoningPanel";
import { defaultSession, readySessions, sessionForModel } from "./ready";
import {
  composerAction,
  copyFeedback,
  omittedNotice,
  turnStatusText
} from "./chat-actions";
import {
  IMAGE_ACCEPT,
  canAttachImages,
  dataUrlFor,
  readImageFile,
  type PendingImage
} from "./attachments";

interface StreamingBubble {
  reasoning: string;
  content: string;
}

/** Echoed until the stored transcript arrives for the first turn of a chat. */
interface PendingUserTurn {
  content: string;
  previews: string[];
}

export function ChatPage() {
  const {
    sessions,
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
  const [pendingUser, setPendingUser] = useState<PendingUserTurn | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Images picked for the next turn; cleared once the turn is accepted.
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [creating, setCreating] = useState(false);
  // Reading preferences are account settings, read synchronously here.
  const preferences = useUiPreferences();
  const studentMode = preferences.studentMode;
  const historyOpen = preferences.historyOpen;
  const [atBottom, setAtBottom] = useState(true);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [omitted, setOmitted] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // On a phone the history rail would take two thirds of the width, so it becomes a
  // drawer over the conversation. The stored preference keeps controlling the
  // desktop rail; the drawer is per-visit state.
  const phone = usePhoneLayout();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerToggle = useRef<HTMLButtonElement>(null);
  useKeyboardInset();

  const historyVisible = phone ? drawerOpen : historyOpen;

  useEffect(() => {
    if (!phone) {
      setDrawerOpen(false);
    }
  }, [phone]);

  const closeDrawer = useCallback((): void => {
    setDrawerOpen(false);
    drawerToggle.current?.focus();
  }, []);

  useEffect(() => {
    if (!drawerOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeDrawer();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeDrawer, drawerOpen]);  const transcriptRef = useRef<HTMLDivElement>(null);
  // Streaming must not yank the transcript back to the bottom: scrolling up to
  // re-read an earlier step has to stay possible until the user returns.
  const stickToBottomRef = useRef(true);
  // Event transports can deliver the last deltas after the send resolves; those
  // must not paint a second bubble over the stored transcript.
  const inFlightRef = useRef(false);

  // Only models that are serving can be used here. Starting, pricing, progress
  // and teardown belong to Models; Chat is for talking to a ready model.
  const usableSessions = readySessions(sessions);
  const activeSession = usableSessions.find((session) => session.id === activeSessionId) ?? null;
  // A restart keeps the same run but leaves `usableSessions`; find it in the full
  // list so Chat can explain the pause instead of calling the model missing.
  const restartingSession = detail?.conversation.modelId
    ? sessions.find(
        (session) =>
          session.modelId === detail.conversation.modelId && session.restart !== null
      ) ?? null
    : null;
  const frozen =
    detail !== null &&
    detail.conversation.modelId !== null &&
    !restartingSession &&
    !usableSessions.some((session) => session.modelId === detail.conversation.modelId);

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
      updatePreferences({ lastConversationId: id });
      setStreaming(null);
      const result = await bridge.invoke<ConversationDetail>("conversation.get", { id });

      if (result.ok) {
        setDetail(result.data);
        const match = sessionForModel(usableSessions, result.data.conversation.modelId);
        setActiveSessionId(match?.id ?? null);
      } else if (result.error.code === "NOT_FOUND") {
        // The remembered chat was deleted, or belonged to a different install:
        // forget it quietly instead of alerting on every visit to the page.
        updatePreferences({ lastConversationId: null });
        setActiveConversationId(null);
        setDetail(null);
        void loadConversations();
      } else {
        setError(result.error.message);
      }
    },
    [loadConversations, usableSessions]
  );

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // The run's own numbers, so the person can see the machine they are talking
  // to without leaving the conversation (FR-037).
  useEffect(() => {
    const bridge = window.maia;
    if (!bridge || !activeSession) {
      setRuntimeConfig(null);
      return;
    }

    let cancelled = false;
    const load = async (): Promise<void> => {
      const result = await bridge.invoke<RuntimeConfig | null>("session.runtimeConfig", {
        sessionId: activeSession.id
      });
      if (!cancelled && result.ok) {
        setRuntimeConfig(result.data);
      }
    };

    void load();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      void load();
    }, 10_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeSession]);

  // Routes are lazily loaded, so coming back to the chat remounts this component.
  // The resume point arrives with the settings, so this waits for it once.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) {
      return;
    }

    const last = preferences.lastConversationId;
    if (!last) {
      return;
    }

    restoredRef.current = true;
    void openConversation(last);
  }, [openConversation, preferences.lastConversationId]);

  // Starting a model from the catalogue lands here: select that session so the
  // composer is usable straight away instead of asking for a new chat.
  useEffect(() => {
    if (!focusSessionId) {
      return;
    }

    if (usableSessions.some((session) => session.id === focusSessionId)) {
      setActiveSessionId(focusSessionId);
      clearFocusSession();
    }
  }, [clearFocusSession, focusSessionId, usableSessions]);

  // A new chat has no stored conversation to take its model from, so it starts
  // on the first ready one. An open conversation keeps its own model: if that
  // model is gone, the frozen notice explains it instead of silently borrowing
  // another model's answers.
  useEffect(() => {
    if (detail !== null) {
      return;
    }

    const next = defaultSession(usableSessions, activeSessionId);
    if (next && next.id !== activeSessionId) {
      setActiveSessionId(next.id);
    }
  }, [activeSessionId, detail, usableSessions]);

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
                        images: [],
                        interrupted: false,
                        errorCode: null,
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
    updatePreferences({ lastConversationId: null });
    setDetail(null);
    setStreaming(null);
    setPendingUser(null);
    setActiveSessionId(sessions[0]?.id ?? null);
    setDraft("");
  }

  function toggleHistory(): void {
    updatePreferences({ historyOpen: !historyOpen });
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

    const outgoing = pendingImages;
    const editingId = editing?.id ?? null;
    setDraft("");
    setPendingImages([]);
    setBusy(true);
    inFlightRef.current = true;
    setError(null);
    setAnnouncement(turnStatusText("started"));
    setOmitted(0);
    setPendingUser(
      activeConversationId || editingId
        ? null
        : {
            content,
            previews: outgoing.map((image) => dataUrlFor(image.mimeType, image.dataBase64))
          }
    );
    if (!editingId) {
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
                  images: [],
                  interrupted: false,
                  errorCode: null,
                  createdAt: new Date().toISOString()
                }
              ]
            }
          : existing
      );
    }
    setStreaming({ reasoning: "", content: "" });

    const result = editingId
      ? await bridge.invoke<ChatTurnResult>("chat.edit", {
          sessionId: activeSession.id,
          conversationId: activeConversationId,
          userMessageId: editingId,
          content
        })
      : await bridge.invoke<ChatTurnResult>("chat.send", {
          sessionId: activeSession.id,
          conversationId: activeConversationId ?? undefined,
          content,
          images: outgoing.map((image) => ({
            mimeType: image.mimeType,
            dataBase64: image.dataBase64
          }))
        });

    if (!result.ok) {
      setBusy(false);
      inFlightRef.current = false;
      setStreaming(null);
      setError(result.error.message);
      setAnnouncement(turnStatusText("failed"));
      // The turn never happened, so the draft and its images are kept.
      setDraft((current) => (current.length > 0 ? current : content));
      setPendingImages((current) => (current.length > 0 ? current : outgoing));
      // A failed turn is stored as interrupted; reload so the person sees it.
      if (activeConversationId) {
        const reloaded = await bridge.invoke<ConversationDetail>("conversation.get", {
          id: activeConversationId
        });
        if (reloaded.ok) {
          setDetail(reloaded.data);
        }
      }
      return;
    }

    const editedConversationId = result.data.conversationId;

    if (!activeConversationId) {
      setActiveConversationId(result.data.conversationId);
      updatePreferences({ lastConversationId: result.data.conversationId });
      setCreating(false);
      await loadConversations();
    }

    setOmitted(result.data.omittedMessages);
    setAnnouncement(turnStatusText("finished"));
    setEditing(null);

    // The first message creates the conversation, so the stored transcript has to
    // be loaded — otherwise the reply streams into a view that never renders it.
    const loaded = await bridge.invoke<ConversationDetail>("conversation.get", {
      id: editedConversationId
    });
    if (loaded.ok) {
      setDetail(loaded.data);
      setStreaming(null);
      setPendingUser(null);
    }

    inFlightRef.current = false;
    setBusy(false);
  }

  /** Copies a message; the clipboard can be unavailable, so the label says so. */
  async function copyMessage(content: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(content);
      setAnnouncement(copyFeedback(true));
    } catch {
      setAnnouncement(copyFeedback(false));
    }
  }

  /** Asks again for one reply; the old attempt stays in storage. */
  async function regenerate(messageId: string): Promise<void> {
    const bridge = window.maia;
    if (!bridge || !activeSession || !activeConversationId) {
      return;
    }

    setBusy(true);
    inFlightRef.current = true;
    setStreaming({ reasoning: "", content: "" });
    setAnnouncement(turnStatusText("started"));

    const result = await bridge.invoke<ChatTurnResult>("chat.regenerate", {
      sessionId: activeSession.id,
      conversationId: activeConversationId,
      assistantMessageId: messageId
    });

    inFlightRef.current = false;
    setBusy(false);
    setStreaming(null);

    if (!result.ok) {
      setError(result.error.message);
      setAnnouncement(turnStatusText("failed"));
      return;
    }

    setOmitted(result.data.omittedMessages);
    setAnnouncement(turnStatusText("finished"));
    const loaded = await bridge.invoke<ConversationDetail>("conversation.get", {
      id: activeConversationId
    });
    if (loaded.ok) {
      setDetail(loaded.data);
    }
  }

  function startEdit(messageId: string, content: string): void {
    setEditing({ id: messageId, content });
    setDraft(content);
    // The composer is where the edit happens; put the cursor there.
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function cancelEdit(): void {
    setEditing(null);
    setDraft("");
  }

  /** Picks up files from the hidden input; each one is validated before it joins the turn. */
  async function attachFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) {
      return;
    }

    let count = pendingImages.length;
    const added: PendingImage[] = [];

    for (const file of Array.from(files)) {
      const result = await readImageFile(file, count);
      if (!result.ok) {
        setError(result.error);
        continue;
      }

      added.push(result.image);
      count += 1;
    }

    if (added.length > 0) {
      setPendingImages((current) => [...current, ...added]);
    }
  }

  function removeImage(id: string): void {
    setPendingImages((current) => current.filter((image) => image.id !== id));
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

  const showError = error ?? workspaceError;
  // A rejected run key is fixed by a restart, not by the person pasting it.
  const credentialFailure = showError ? /rejected the run's key/i.test(showError) : false;
  // Only the two refusals this feature introduced get a shortcut.
  const refusalSection = showError
    ? /vast\.ai/i.test(showError)
      ? "vastai"
      : /hugging face/i.test(showError)
        ? "huggingface"
        : null
    : null;

  return (
    <section
      className={`chat-layout${historyVisible ? "" : " history-collapsed"}${phone && drawerOpen ? " drawer-open" : ""}`}
    >
      {phone && drawerOpen ? (
        <button
          type="button"
          className="chat-scrim"
          aria-label="Close chat history"
          onClick={closeDrawer}
        />
      ) : null}
      <aside className={historyVisible ? "chat-history" : "chat-history rail"} aria-label="Chat history">
        {historyVisible ? (          <>
            <div className="chat-history-head">
              <strong>Chats</strong>
              <div className="history-head-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    startNewChat();
                    if (phone) {
                      closeDrawer();
                    }
                  }}
                >
                  New
                </button>
                <button
                  type="button"
                  className="icon-mini"
                  title="Collapse chats"
                  aria-label="Collapse chats"
                  aria-expanded={true}
                  onClick={() => (phone ? closeDrawer() : toggleHistory())}
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
                      if (phone) {
                        closeDrawer();
                      }
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
          {phone ? (
            <button
              type="button"
              className="ghost-button history-toggle"
              ref={drawerToggle}
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              Chats
            </button>
          ) : null}
          <label className="inline-field">
            <span>Model</span>
            <select
              value={activeSessionId ?? ""}
              onChange={(event) => {
                const session = usableSessions.find((entry) => entry.id === event.target.value);
                if (session) {
                  void switchModel(session);
                }
                if (!event.target.value) {
                  setActiveSessionId(null);
                }
              }}
            >
              <option value="">
                {usableSessions.length === 0 ? "No model is ready" : "Select a ready model"}
              </option>
              {usableSessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.modelId}
                </option>
              ))}
            </select>
          </label>

          <label className="inline-field reasoning-toggle" title="Show the model's thinking, revealed at a reading pace">
            <input
              type="checkbox"
              checked={studentMode}
              onChange={(event) => {
                updatePreferences({ studentMode: event.target.checked });
              }}
            />
            <span>Student mode</span>
          </label>

          {usableSessions.length === 0 ? (
            <Link className="ghost-button" to="/catalogue">
              Start a model
            </Link>
          ) : (
            <Link className="ghost-button" to="/models">
              Model status
            </Link>
          )}

          {runtimeConfig ? (
            <span className="chat-run-values" title="This run's context window and concurrency">
              {runtimeConfig.current.contextWindow.toLocaleString()} tokens ·{" "}
              {runtimeConfig.current.maxConcurrentRequests} at once
            </span>
          ) : null}
        </div>

        {restartingSession ? (
          <div className="alert" role="status">
            <span>
              The model is restarting with new settings. Chat is unavailable for new turns until it
              serves again; the conversation is kept.
            </span>
            <Link className="ghost-button" to={`/models?run=${restartingSession.id}`}>
              Follow the restart
            </Link>
          </div>
        ) : null}

        {showError ? (
          <div className="alert" role="alert">
            <span>{showError}</span>
            {/* A refusal names the fix, so the alert is where the fix links to. */}
            {refusalSection ? (
              <Link className="ghost-button" to={`/settings?section=${refusalSection}`}>
                {refusalSection === "vastai" ? "Add the vast.ai key" : "Add the Hugging Face token"}
              </Link>
            ) : null}
            {credentialFailure ? (
              <Link
                className="ghost-button"
                to={activeSession ? `/models?run=${activeSession.id}` : "/models"}
              >
                Restart the model
              </Link>
            ) : null}
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
              <strong>This chat's model is not ready.</strong>{" "}
              {detail.conversation.modelId} is not serving any more, so this conversation is paused.
              Start or restart a model from Models, then come back.
            </div>
            <div className="update-actions">
              <Link className="ghost-button" to="/models">
                Open Models
              </Link>
              {usableSessions.length > 0 ? (
                <select
                  defaultValue=""
                  onChange={(event) => {
                    const session = usableSessions.find((entry) => entry.id === event.target.value);
                    if (session) {
                      void switchModel(session);
                    }
                  }}
                >
                  <option value="" disabled>
                    Continue with another model…
                  </option>
                  {usableSessions.map((session) => (
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
              messageId={message.id}
              role={message.role}
              content={message.content}
              reasoning={message.reasoning}
              images={message.images}
              interrupted={message.interrupted}
              errorCode={message.errorCode}
              studentMode={studentMode}
              busy={busy}
              onCopy={copyMessage}
              onRegenerate={regenerate}
              onEdit={startEdit}
            />
          ))}
          {detail === null && pendingUser ? (
            <article className="bubble bubble-user">
              <header>You</header>
              <div className="bubble-images">
                {pendingUser.previews.map((preview) => (
                  <img key={preview.slice(-32)} src={preview} alt="" />
                ))}
              </div>
              <p>{pendingUser.content}</p>
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

        {omittedNotice(omitted) ? (
          <p className="chat-omitted" role="status">
            {omittedNotice(omitted)}
          </p>
        ) : null}

        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {editing ? (
            <div className="composer-editing" role="status">
              <span>Editing a sent message. Sending replaces it and its answer.</span>
              <button type="button" className="ghost-button" onClick={cancelEdit}>
                Cancel
              </button>
            </div>
          ) : null}
          {pendingImages.length > 0 ? (
            <div className="composer-attachments">
              {pendingImages.map((image) => (
                <figure key={image.id} className="composer-attachment">
                  <img src={dataUrlFor(image.mimeType, image.dataBase64)} alt={image.name} />
                  <button
                    type="button"
                    className="icon-mini"
                    title={`Remove ${image.name}`}
                    aria-label={`Remove ${image.name}`}
                    onClick={() => removeImage(image.id)}
                  >
                    ×
                  </button>
                </figure>
              ))}
            </div>
          ) : null}
          <textarea
            ref={composerRef}
            rows={3}
            value={draft}
            placeholder={
              activeSession
                ? "Ask the model something…"
                : frozen
                  ? "This chat's model is not ready — start one in Models."
                  : "Start a model from the catalogue to chat."
            }
            disabled={!activeSession || busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              const action = composerAction({
                key: event.key,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing
              });
              if (action === "send") {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="update-actions">
            {canAttachImages(activeSession) ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={IMAGE_ACCEPT}
                  multiple
                  hidden
                  onChange={(event) => {
                    void attachFiles(event.target.files);
                    // Clearing lets the same file be picked again after removal.
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="ghost-button"
                  title="Attach an image for this model to look at"
                  disabled={!activeSession || busy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Attach image
                </button>
              </>
            ) : null}
            <button type="submit" disabled={!activeSession || busy || draft.trim().length === 0}>
              {busy ? "Generating…" : "Send"}
            </button>
            {busy && activeSession ? (
              <button
                type="button"
                className="ghost-button"
                onClick={async () => {
                  setAnnouncement(turnStatusText("stopped"));
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
  messageId,
  role,
  content,
  reasoning,
  images,
  interrupted,
  errorCode,
  studentMode,
  busy,
  onCopy,
  onRegenerate,
  onEdit
}: {
  messageId: string;
  role: string;
  content: string;
  reasoning?: string | null;
  images?: ChatImage[];
  interrupted?: boolean;
  errorCode?: string | null;
  studentMode: boolean;
  busy: boolean;
  onCopy: (content: string) => Promise<void>;
  onRegenerate: (messageId: string) => Promise<void>;
  onEdit: (messageId: string, content: string) => void;
}) {
  const isAssistant = role === "assistant";
  const isUser = role === "user";
  const failed = interrupted === true && errorCode !== null && errorCode !== "STOPPED";

  return (
    <article className={`bubble bubble-${role}${interrupted ? " bubble-interrupted" : ""}`}>
      <header>{roleLabel(role)}</header>
      {images && images.length > 0 ? <MessageImages images={images} /> : null}
      {reasoning ? (
        <ReasoningPanel text={reasoning} streaming={false} studentMode={studentMode} variant="inline" />
      ) : null}
      {content.length > 0 ? <MessageContent text={content} /> : null}
      {interrupted ? (
        <p className="bubble-turn-note">
          {failed
            ? `This reply did not finish. ${errorCode}`
            : "This reply was stopped. What had arrived is kept below."}
        </p>
      ) : null}
      <div className="bubble-actions">
        {content.length > 0 ? (
          <button type="button" className="ghost-button" onClick={() => void onCopy(content)}>
            Copy
          </button>
        ) : null}
        {isAssistant ? (
          <button
            type="button"
            className="ghost-button"
            disabled={busy}
            onClick={() => void onRegenerate(messageId)}
          >
            {failed ? "Retry" : "Ask again"}
          </button>
        ) : null}
        {isUser ? (
          <button type="button" className="ghost-button" onClick={() => onEdit(messageId, content)}>
            Edit
          </button>
        ) : null}
      </div>
    </article>
  );
});

/**
 * Stored images load one at a time over IPC: a transcript with four 20 MB images
 * must not arrive as a single payload just because the chat was reopened.
 */
function MessageImages({ images }: { images: ChatImage[] }) {
  const [sources, setSources] = useState<Record<string, string>>({});
  const ids = images.map((image) => image.id).join(",");

  useEffect(() => {
    const bridge = window.maia;
    if (!bridge || ids.length === 0) {
      return;
    }

    let cancelled = false;

    for (const id of ids.split(",")) {
      void bridge
        .invoke<{ id: string; mimeType: string; dataBase64: string }>("conversation.image", { id })
        .then((result) => {
          if (cancelled || !result.ok) {
            return;
          }

          const source = dataUrlFor(result.data.mimeType, result.data.dataBase64);
          setSources((current) => (current[id] ? current : { ...current, [id]: source }));
        });
    }

    return () => {
      cancelled = true;
    };
  }, [ids]);

  return (
    <div className="bubble-images">
      {images.map((image) =>
        sources[image.id] ? (
          <img
            key={image.id}
            src={sources[image.id]}
            alt=""
            width={image.width}
            height={image.height}
            loading="lazy"
          />
        ) : null
      )}
    </div>
  );
}

