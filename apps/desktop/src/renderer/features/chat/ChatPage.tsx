import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorkspace } from "../../shared/session/WorkspaceProvider";
import { accruedMicroUsd, formatElapsed, formatUsd } from "../../shared/format";

export function ChatPage() {
  const { session, messages, streaming, sendMessage, abort, endSession, error, clearError } =
    useWorkspace();
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!session) {
      return;
    }

    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (!session) {
    return (
      <section>
        <p className="eyebrow">Chat</p>
        <h1>No active session</h1>
        <p className="lede">
          Pick a model in the catalogue, review the estimate, and confirm it to start a session.
        </p>
        <Link className="nav-link active" to="/catalogue">
          Go to the catalogue
        </Link>
      </section>
    );
  }

  return (
    <section>
      <p className="eyebrow">Chat</p>
      <h1>{session.modelId}</h1>

      <div className="session-bar">
        <span className="pill pill-ok">{session.state}</span>
        <span className="pill">{session.gpuName ?? "GPU"}</span>
        <span className="pill">{formatUsd(session.hourlyRateMicroUsd)}/h</span>
        <span className="pill">elapsed {formatElapsed(session.startedAt, now)}</span>
        <span className="pill">
          accrued {formatUsd(accruedMicroUsd(session.hourlyRateMicroUsd, session.startedAt, now))}
        </span>
        {session.simulated ? <span className="pill pill-warning">simulated</span> : null}
        <button type="button" className="ghost-button" onClick={() => void endSession()}>
          End session and release GPU
        </button>
      </div>

      {error ? (
        <div className="alert" role="alert">
          <span>{error}</span>
          <button type="button" className="ghost-button" onClick={clearError}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="transcript">
        {messages.length === 0 ? (
          <p className="muted">Send the first message to start generating.</p>
        ) : null}
        {messages.map((message) => (
          <article key={message.id} className={`bubble bubble-${message.role}`}>
            <header>
              {message.role === "user" ? "You" : "Model"}
              {message.tokens ? <span className="muted small"> · {message.tokens} tokens</span> : null}
            </header>
            <p>{message.content || (message.streaming ? "…" : "")}</p>
          </article>
        ))}
        <div ref={endRef} />
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          const content = draft.trim();
          if (!content || streaming) {
            return;
          }
          setDraft("");
          void sendMessage(content);
        }}
      >
        <textarea
          value={draft}
          rows={3}
          placeholder="Ask the model something…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="update-actions">
          <button type="submit" disabled={streaming || draft.trim().length === 0}>
            {streaming ? "Generating…" : "Send"}
          </button>
          {streaming ? (
            <button type="button" className="ghost-button" onClick={() => void abort()}>
              Stop
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
