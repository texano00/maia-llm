import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { DEFAULT_IDE_ENDPOINT_PORT, type IntegrationStatus } from "@maia/contracts";
import { writeClipboard } from "../../shared/clipboard";
import { CodeBlock } from "../chat/CodeBlock";

/**
 * Opt-in bridge between the app and local IDE assistants.
 *
 * Ollama-compatible extensions (Continue, Cline, JetBrains "Ollama" providers…)
 * only need two facts: a base URL and a model name. Both are shown here, copyable,
 * and only while the endpoint is actually serving — a stale value is worse than a
 * clear "no model running" notice.
 */
export function IntegrationPage() {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [port, setPort] = useState(String(DEFAULT_IDE_ENDPOINT_PORT));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await window.maia?.invoke<IntegrationStatus>("integration.status");
    if (!result) {
      return;
    }

    if (result.ok) {
      setStatus(result.data);
      // Only follow the bound port; otherwise the user's edit in the input wins.
      if (result.data.port !== null) {
        setPort(String(result.data.port));
      }
    } else {
      setError(result.error.message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [load]);

  async function toggle(next: boolean): Promise<void> {
    setBusy(true);
    setError(null);

    const parsed = Number(port);
    const result = await window.maia?.invoke<IntegrationStatus>(
      next ? "integration.enable" : "integration.disable",
      next && Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65_535 ? { port: parsed } : {}
    );

    setBusy(false);

    if (!result) {
      return;
    }

    if (result.ok) {
      setStatus(result.data);
      if (result.data.port !== null) {
        setPort(String(result.data.port));
      }
    } else {
      setError(result.error.message);
    }
  }

  async function copy(label: string, value: string): Promise<void> {
    if (!(await writeClipboard(value))) {
      setError("The clipboard is not available; select the text and copy it manually.");
      return;
    }

    setCopied(label);
    setTimeout(() => setCopied(null), 1_600);
  }

  const baseUrl = status?.baseUrl ?? `http://127.0.0.1:${port}`;
  const model = status?.model ?? "<author>/<name>:latest";
  const running = status?.running === true;

  const continueConfig = JSON.stringify(
    {
      models: [
        {
          title: "Maia LLM",
          provider: "ollama",
          model,
          apiBase: baseUrl
        }
      ]
    },
    null,
    2
  );

  const curlExample = `curl -s ${baseUrl}/api/chat \\
  -H 'content-type: application/json' \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"Explain this function"}]}'`;

  return (
    <section>
      <p className="eyebrow">IDE integration</p>
      <h1>Use this model from your editor</h1>
      <p className="lede">
        Maia LLM can re-publish the running model as an Ollama-compatible API on
        this computer, so VS Code extensions such as Continue or Cline can use it
        without any extra setup. Nothing listens until you enable it, and the port
        is released as soon as the session ends.
      </p>

      {error ? (
        <div className="alert" role="alert">
          <span>{error}</span>
          <button type="button" className="ghost-button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="integration-grid">
        <div className="panel">
          <h2>Endpoint</h2>
          <div className="metric-row">
            <span className={running ? "pill pill-ok" : status?.enabled ? "pill pill-warning" : "pill"}>
              {running ? "listening" : status?.enabled ? "enabled · waiting for a model" : "off"}
            </span>
            {status?.sessionRunning ? <span className="pill pill-ok">session running</span> : null}
            {status?.error ? <span className="pill pill-danger">{status.error}</span> : null}
          </div>

          <label className="field">
            <span>Port</span>
            <input
              inputMode="numeric"
              value={port}
              onChange={(event) => setPort(event.target.value.replace(/[^\d]/g, ""))}
              disabled={running || busy}
            />
          </label>
          <p className="field-hint">
            Default {DEFAULT_IDE_ENDPOINT_PORT}. If the port is taken, the next free
            one between {DEFAULT_IDE_ENDPOINT_PORT + 1} and 11534 is used and shown
            here.
          </p>

          <div className="update-actions">
            {status?.enabled ? (
              <button type="button" className="ghost-button" disabled={busy} onClick={() => void toggle(false)}>
                {busy ? "Working…" : "Disable endpoint"}
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => void toggle(true)}>
                {busy ? "Working…" : "Enable local endpoint"}
              </button>
            )}
            <Link className="ghost-button" to="/catalogue">
              Start a model
            </Link>
          </div>

          {status?.enabled && !status.sessionRunning ? (
            <p className="pill pill-warning" role="note">
              No model is running. The endpoint starts listening as soon as a session is
              active.
            </p>
          ) : null}

          {running ? (
            <>
              <div className="endpoint-field">
                <code className="endpoint-value">{baseUrl}</code>
                <button type="button" className="ghost-button" onClick={() => void copy("url", baseUrl)}>
                  {copied === "url" ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="endpoint-field">
                <code className="endpoint-value">{model}</code>
                <button type="button" className="ghost-button" onClick={() => void copy("model", model)}>
                  {copied === "model" ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="metric-row">
                <span className="pill">{status.requests} requests</span>
                <span className="pill">{status.clients} clients</span>
                <span className="pill">{status.inFlight} in flight</span>
                {status.lastActivityAt ? (
                  <span className="pill">last {new Date(status.lastActivityAt).toLocaleTimeString()}</span>
                ) : null}
              </div>
            </>
          ) : null}
        </div>

        <div className="panel">
          <h2>Connect VS Code</h2>
          <ol className="step-list">
            <li>Install an Ollama-compatible extension (Continue, Cline, or any client that speaks the Ollama API).</li>
            <li>Pick “Ollama” as the provider and paste the base URL and model name above.</li>
            <li>Send a prompt from the editor; the request appears in the usage counters on the left.</li>
          </ol>

          <p className="field-hint">
            Continue reads this from <code>config.json</code>:
          </p>
          <CodeBlock code={continueConfig} language="json" />

          <p className="field-hint">Any Ollama client can also call it directly:</p>
          <CodeBlock code={curlExample} language="sh" />

          <p className="field-hint">
            The endpoint is bound to 127.0.0.1 only, rejects requests that arrive with a
            foreign <code>Host</code> header, and stops when the session stops or the app
            closes. IDE conversations are stored separately per client in the chat
            history.
          </p>
        </div>
      </div>
    </section>
  );
}
