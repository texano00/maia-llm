import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionLogsResult } from "@maia/contracts";

type Kind = "instance" | "debug";

const SECTIONS: ReadonlyArray<{ kind: Kind; label: string; help: string }> = [
  {
    kind: "instance",
    label: "Instance logs",
    help: "What the engine prints inside the container — the model server's own stdout."
  },
  {
    kind: "debug",
    label: "Extra debug logs",
    help: "The instance record vast.ai keeps (status, machine, ports) plus the host-side daemon log."
  }
];

const POLL_MS = 2_500;

/**
 * The live logs of one run, straight from vast.ai.
 *
 * A boot that is not working is invisible from the outside: the screen says
 * "initializing" and the reason is in the container's stdout. This view polls the
 * provider while it is open — and only while it is open — so the log scrolls as the
 * machine talks, and stops costing requests when the panel is closed.
 *
 * Both sources are always offered: the container log explains the engine, the
 * daemon log explains the container that never got that far.
 */
export function RunLogs({ sessionId }: { sessionId: string }) {
  const [kind, setKind] = useState<Kind>("instance");
  const [result, setResult] = useState<SessionLogsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);

  const load = useCallback(
    async (which: Kind) => {
      const bridge = window.maia;
      if (!bridge) {
        return;
      }

      const answer = await bridge.invoke<SessionLogsResult>("session.logs", {
        sessionId,
        kind: which,
        tail: 400
      });

      if (answer.ok) {
        setResult(answer.data);
        setError(null);
      } else {
        setError(answer.error.message);
      }
    },
    [sessionId]
  );

  useEffect(() => {
    setResult(null);
    setError(null);
    void load(kind);
  }, [kind, load]);

  useEffect(() => {
    if (paused) {
      return;
    }

    const timer = setInterval(() => {
      void load(kind);
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [kind, load, paused]);

  // Follow the tail like a terminal, unless the person has scrolled up.
  useEffect(() => {
    const node = logRef.current;
    if (!node || !follow) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [follow, result]);

  return (
    <div className="run-logs">
      <div className="run-logs-head">
        <div className="run-logs-tabs" role="tablist" aria-label="Log source">
          {SECTIONS.map((section) => (
            <button
              key={section.kind}
              type="button"
              role="tab"
              aria-selected={kind === section.kind}
              className={kind === section.kind ? "ghost-button active" : "ghost-button"}
              onClick={() => setKind(section.kind)}
            >
              {section.label}
            </button>
          ))}
        </div>
        <div className="run-logs-actions">
          <span className="muted small">
            {paused
              ? "Paused"
              : result?.live
                ? "Live · refreshing every few seconds"
                : "Run finished · last read"}
          </span>
          <button type="button" className="ghost-button" onClick={() => setPaused((v) => !v)}>
            {paused ? "Resume" : "Pause"}
          </button>
          <button type="button" className="ghost-button" onClick={() => void load(kind)}>
            Refresh
          </button>
        </div>
      </div>

      <p className="muted small">
        {SECTIONS.find((section) => section.kind === kind)?.help}
      </p>

      {error ? <p className="small">{error}</p> : null}

      <pre
        className="run-logs-body"
        ref={logRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 32);
        }}
      >
        {result?.text ?? result?.note ?? "Reading…"}
      </pre>
    </div>
  );
}
