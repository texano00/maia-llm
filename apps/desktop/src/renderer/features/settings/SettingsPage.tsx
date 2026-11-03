import { useEffect, useState } from "react";
import { DEFAULT_DIAGNOSTICS_URL, type AppSettings } from "@maia/contracts";
import { useUpdates } from "../../shared/updates/UpdatesProvider";
import { describeUpdateStatus } from "../../shared/updates/UpdateToast";

export function SettingsPage() {
  const { appInfo, status, bridgeAvailable, check, download, install } = useUpdates();
  const busy = status?.phase === "checking" || status?.phase === "downloading";

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [diagnosticsUrl, setDiagnosticsUrl] = useState(DEFAULT_DIAGNOSTICS_URL);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    let mounted = true;
    void bridge.invoke<AppSettings>("settings.get").then((result) => {
      if (!mounted) {
        return;
      }

      if (result.ok) {
        setSettings(result.data);
        setDiagnosticsUrl(result.data.diagnosticsUrl);
      }
    });

    return () => {
      mounted = false;
    };
  }, []);

  async function saveDiagnostics(next: string): Promise<void> {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    setSaveState("saving");
    setError(null);

    const result = await bridge.invoke<AppSettings>("settings.update", {
      diagnosticsUrl: next
    });

    if (result.ok) {
      setSettings(result.data);
      setDiagnosticsUrl(result.data.diagnosticsUrl);
      setSaveState("saved");
      return;
    }

    setSaveState("error");
    setError(result.error.message);
  }

  return (
    <section>
      <p className="eyebrow">Settings</p>
      <h1>Providers and preferences</h1>
      <p className="lede">
        Hugging Face, vast.ai, and S3 credentials will be stored in the operating-system credential
        vault here.
      </p>

      {bridgeAvailable ? null : (
        <p className="field-error">
          The application bridge is unavailable. Settings cannot be read or saved — reinstall Maia
          LLM.
        </p>
      )}

      <div className="settings-card">
        <div>
          <h2>Application updates</h2>
          <p className="lede">
            Installed version {appInfo?.app ?? "—"} on the {status?.channel ?? "stable"} channel.
          </p>
          <p className="update-meta">{describeUpdateStatus(status)}</p>
        </div>
        <div className="update-actions">
          {status?.phase === "available" ? (
            <button type="button" onClick={() => void download()}>
              Update now
            </button>
          ) : status?.phase === "ready" ? (
            <button type="button" onClick={() => void install()}>
              Restart and install
            </button>
          ) : status?.phase === "installing" ? (
            <button type="button" disabled>
              Installing…
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || (status !== null && !status.supported)}
              onClick={() => void check()}
            >
              {status?.phase === "checking" ? "Checking…" : "Check for updates"}
            </button>
          )}
        </div>
      </div>

      <form
        className="settings-card settings-card-stacked"
        onSubmit={(event) => {
          event.preventDefault();
          void saveDiagnostics(diagnosticsUrl);
        }}
      >
        <div>
          <h2>Telemetry and diagnostics host</h2>
          <p className="lede">
            While testing, Maia mirrors its log to this host so the app can be observed live. Logs
            never include prompts, responses, or credentials.
          </p>
          <label className="field">
            <span>Host</span>
            <input
              type="url"
              inputMode="url"
              spellCheck={false}
              placeholder={DEFAULT_DIAGNOSTICS_URL}
              value={diagnosticsUrl}
              onChange={(event) => {
                setDiagnosticsUrl(event.target.value);
                setSaveState("idle");
              }}
            />
          </label>
          <p className="field-hint">
            Default {DEFAULT_DIAGNOSTICS_URL}. The app posts to <code>/v1/diagnostics/logs</code> on
            that host.{settings ? "" : " Loading saved settings…"}
          </p>
          {error ? <p className="field-error">{error}</p> : null}
          {saveState === "saved" ? (
            <p className="field-hint">Saved. Logs now go to the new host.</p>
          ) : null}
        </div>
        <div className="update-actions">
          <button type="submit" disabled={!bridgeAvailable || saveState === "saving"}>
            {saveState === "saving" ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={!bridgeAvailable}
            onClick={() => void saveDiagnostics(DEFAULT_DIAGNOSTICS_URL)}
          >
            Reset to default
          </button>
        </div>
      </form>
    </section>
  );
}
