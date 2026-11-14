import { useCallback, useEffect, useState } from "react";
import type { SessionEndpoint } from "@maia/contracts";
import { maskKey, publicUrl } from "./external-access";
import { agenticTools } from "./agentic-tools";

/**
 * Shows how to point another tool at this run. The endpoint only exists while
 * the server serves, so the panel renders nothing until the app can describe it.
 */
export function ExternalAccessPanel({ sessionId }: { sessionId: string }) {
  const [endpoint, setEndpoint] = useState<SessionEndpoint | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    let cancelled = false;
    const load = async (): Promise<void> => {
      const result = await bridge.invoke<SessionEndpoint | null>("session.endpoint", {
        sessionId
      });
      if (!cancelled && result.ok) {
        setEndpoint(result.data);
      }
    };

    void load();
    // The address appears when the host maps the port, which can be minutes into a
    // boot; asking once meant the panel stayed empty until a reload.
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
  }, [sessionId]);

  const copy = useCallback(async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // A clipboard can be unavailable; the text stays selectable.
    }
  }, []);

  if (!endpoint) {
    return null;
  }

  const tools = agenticTools(endpoint);

  return (
    <details className="external-access">
      <summary>How to use this model in VS Code, Cursor, Cline…</summary>
      <dl className="model-run-facts">
        <div>
          <dt>Public URL</dt>
          <dd>
            {/* Opens in a new tab: it is a different server, not a screen of this
                app, and navigating away would lose the run list. */}
            <a href={publicUrl(endpoint.baseUrl)} target="_blank" rel="noreferrer noopener">
              {publicUrl(endpoint.baseUrl)}
            </a>
          </dd>
        </div>
        <div>
          <dt>Base URL</dt>
          <dd>
            <code>{endpoint.baseUrl}</code>
          </dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>
            <code>{endpoint.modelId}</code>
          </dd>
        </div>
        <div>
          <dt>Key</dt>
          <dd>
            <code>{revealed ? endpoint.apiKey : maskKey(endpoint.apiKey)}</code>{" "}
            <button type="button" className="ghost-button" onClick={() => setRevealed((value) => !value)}>
              {revealed ? "Hide" : "Reveal"}
            </button>
          </dd>
        </div>
      </dl>

      <p className="muted small">
        Pick the tool you use. Every entry needs the same four values, and each is
        collapsible — copy the one that applies.
      </p>

      {tools.map((tool) => (
        <details className="external-access-tool" key={tool.id}>
          <summary>
            <strong>{tool.title}</strong> <span className="muted">— {tool.blurb}</span>
          </summary>
          {tool.steps.length > 0 ? (
            <ol className="external-access-steps">
              {tool.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          ) : null}
          {tool.snippet ? (
            <div className="external-access-snippet">
              <div className="external-access-head">
                <span>{tool.language}</span>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void copy(tool.id, tool.snippet ?? "")}
                >
                  {copied === tool.id ? "Copied" : "Copy"}
                </button>
              </div>
              <pre>
                <code>{tool.snippet}</code>
              </pre>
            </div>
          ) : null}
        </details>
      ))}

      <p className="muted small">
        The address and key belong to this run. They stop working the moment it ends, and the key is
        never written to logs or sent anywhere except this model server.
      </p>
    </details>
  );
}
