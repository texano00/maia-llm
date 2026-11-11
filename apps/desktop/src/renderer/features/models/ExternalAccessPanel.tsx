import { useCallback, useEffect, useState } from "react";
import type { SessionEndpoint } from "@maia/contracts";
import { buildEditorConfig, buildOpenAiRequest, maskKey } from "./external-access";

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
    void bridge.invoke<SessionEndpoint | null>("session.endpoint", { sessionId }).then((result) => {
      if (!cancelled && result.ok) {
        setEndpoint(result.data);
      }
    });

    return () => {
      cancelled = true;
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

  const request = buildOpenAiRequest(endpoint);
  const editorConfig = buildEditorConfig(endpoint);

  return (
    <details className="external-access">
      <summary>Use this model from another tool</summary>
      <dl className="model-run-facts">
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

      <div className="external-access-snippet">
        <div className="external-access-head">
          <span>OpenAI-compatible request</span>
          <button type="button" className="ghost-button" onClick={() => void copy("request", request)}>
            {copied === "request" ? "Copied" : "Copy"}
          </button>
        </div>
        <pre>
          <code>{request}</code>
        </pre>
      </div>

      <div className="external-access-snippet">
        <div className="external-access-head">
          <span>Editor configuration (VS Code · Continue/Cline)</span>
          <button type="button" className="ghost-button" onClick={() => void copy("editor", editorConfig)}>
            {copied === "editor" ? "Copied" : "Copy"}
          </button>
        </div>
        <pre>
          <code>{editorConfig}</code>
        </pre>
      </div>

      <p className="muted small">
        The address and key belong to this run. They stop working the moment it ends, and the key is
        never written to logs or sent anywhere except this model server.
      </p>
    </details>
  );
}
