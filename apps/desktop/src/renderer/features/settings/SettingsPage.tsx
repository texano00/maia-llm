import { useEffect, useState } from "react";
import {
  DEFAULT_DIAGNOSTICS_URL,
  DEFAULT_GPU_FILTERS,
  DEFAULT_GPU_STARTUP_RETRIES,
  DEFAULT_MIN_DISK_BANDWIDTH_MBPS,
  DEFAULT_MIN_DOWNLOAD_MBPS,
  DEFAULT_MIN_UPLOAD_MBPS,
  type AppSettings,
  type CredentialStatus,
  type CredentialTestResult,
  type GpuFilters
} from "@maia/contracts";
import { useUpdates } from "../../shared/updates/UpdatesProvider";
import { describeUpdateStatus } from "../../shared/updates/UpdateToast";

function toPositiveInt(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }

  const parsed = Math.round(Number(trimmed));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toStartupRetries(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 10 ? parsed : null;
}

export function SettingsPage() {
  const { appInfo, status, bridgeAvailable, check, download, install } = useUpdates();
  const busy = status?.phase === "checking" || status?.phase === "downloading";

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [diagnosticsUrl, setDiagnosticsUrl] = useState(DEFAULT_DIAGNOSTICS_URL);
  const [countries, setCountries] = useState("");
  const [datacenters, setDatacenters] = useState("");
  const [minReliability, setMinReliability] = useState("");
  const [maxHourlyUsd, setMaxHourlyUsd] = useState("");
  const [minDownloadMbps, setMinDownloadMbps] = useState("");
  const [minUploadMbps, setMinUploadMbps] = useState("");
  const [minDiskMBps, setMinDiskMBps] = useState("");
  const [gpuStartupRetries, setGpuStartupRetries] = useState(String(DEFAULT_GPU_STARTUP_RETRIES));
  const [walletWarnUsd, setWalletWarnUsd] = useState("2");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [gpuState, setGpuState] = useState<"idle" | "saving" | "saved">("idle");
  const [hfToken, setHfToken] = useState("");
  const [vastKey, setVastKey] = useState("");
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus | null>(null);
  const [hfMessage, setHfMessage] = useState<string | null>(null);
  const [vastMessage, setVastMessage] = useState<string | null>(null);
  const [hfError, setHfError] = useState<string | null>(null);
  const [vastError, setVastError] = useState<string | null>(null);
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
        applyGpuFilters(result.data.gpuFilters);
        setGpuStartupRetries(String(result.data.gpuStartupRetries));
        setWalletWarnUsd(String(result.data.walletWarnThresholdMicroUsd / 1_000_000));
      }
    });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    void window.maia?.invoke<CredentialStatus>("settings.credentials.status").then((result) => {
      if (result.ok) {
        setCredentialStatus(result.data);
      }
    });
  }, []);

  async function saveHuggingFaceToken(): Promise<void> {
    const bridge = window.maia;
    if (!bridge || hfToken.trim().length === 0) {
      return;
    }

    const result = await bridge.invoke<CredentialStatus>("settings.credentials.set", {
      provider: "huggingface",
      secret: hfToken.trim()
    });

    if (result.ok) {
      setCredentialStatus(result.data);
      setHfToken("");
      setHfError(null);
      setHfMessage("Token saved in the OS credential vault.");
    } else {
      setHfMessage(null);
      setHfError(result.error.message);
    }
  }

  async function saveVastKey(): Promise<void> {
    const bridge = window.maia;
    if (!bridge || vastKey.trim().length === 0) {
      return;
    }

    const result = await bridge.invoke<CredentialStatus>("settings.credentials.set", {
      provider: "vastai",
      secret: vastKey.trim()
    });

    if (result.ok) {
      setCredentialStatus(result.data);
      setVastKey("");
      setVastError(null);
      setVastMessage("vast.ai key saved. Restart Maia LLM to rent real GPUs with this key.");
    } else {
      setVastMessage(null);
      setVastError(result.error.message);
    }
  }

  async function testVastKey(): Promise<void> {
    const result = await window.maia?.invoke<CredentialTestResult>("settings.credentials.test", {
      provider: "vastai"
    });

    if (!result) {
      return;
    }

    setVastMessage(result.ok ? result.data.message : result.error.message);
    setVastError(result.ok ? null : result.error.message);
  }

  async function testHuggingFaceToken(): Promise<void> {
    const result = await window.maia?.invoke<CredentialTestResult>("settings.credentials.test", {
      provider: "huggingface"
    });

    if (!result) {
      return;
    }

    setHfMessage(result.ok ? result.data.message : result.error.message);
    setHfError(result.ok ? null : result.error.message);
  }

  function applyGpuFilters(filters: GpuFilters): void {
    setCountries(filters.countries.join(", "));
    setDatacenters(filters.datacenters.join(", "));
    setMinReliability(filters.minReliability === null ? "" : String(filters.minReliability));
    setMaxHourlyUsd(
      filters.maxHourlyMicroUsd === null ? "" : (filters.maxHourlyMicroUsd / 1_000_000).toFixed(2)
    );
    setMinDownloadMbps(filters.minDownloadMbps === null ? "" : String(filters.minDownloadMbps));
    setMinUploadMbps(filters.minUploadMbps === null ? "" : String(filters.minUploadMbps));
    setMinDiskMBps(
      filters.minDiskBandwidthMBps === null ? "" : String(filters.minDiskBandwidthMBps)
    );
  }

  async function saveGpuFilters(override?: GpuFilters): Promise<void> {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    const startupRetries = toStartupRetries(gpuStartupRetries);
    if (startupRetries === null) {
      setGpuState("idle");
      setError("GPU startup retries must be a whole number between 0 and 10.");
      return;
    }

    const warnUsd = Number(walletWarnUsd);
    if (!Number.isFinite(warnUsd) || warnUsd <= 0) {
      setGpuState("idle");
      setError("The wallet warning threshold must be a positive amount in USD.");
      return;
    }

    setGpuState("saving");
    setError(null);
    const filters: GpuFilters = override ?? {
      countries: countries
        .split(",")
        .map((entry) => entry.trim().toUpperCase())
        .filter((entry) => entry.length >= 2),
      datacenters: datacenters
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
      minReliability: minReliability.trim() === "" ? null : Math.min(1, Math.max(0, Number(minReliability))),
      maxHourlyMicroUsd:
        maxHourlyUsd.trim() === "" ? null : Math.round(Number(maxHourlyUsd) * 1_000_000),
      minDownloadMbps: toPositiveInt(minDownloadMbps),
      minUploadMbps: toPositiveInt(minUploadMbps),
      minDiskBandwidthMBps: toPositiveInt(minDiskMBps)
    };

    const result = await bridge.invoke<AppSettings>("settings.update", {
      gpuFilters: filters,
      gpuStartupRetries: startupRetries,
      walletWarnThresholdMicroUsd: Math.round(warnUsd * 1_000_000)
    });

    if (result.ok) {
      setSettings(result.data);
      applyGpuFilters(result.data.gpuFilters);
      setGpuStartupRetries(String(result.data.gpuStartupRetries));
      setWalletWarnUsd(String(result.data.walletWarnThresholdMicroUsd / 1_000_000));
      setGpuState("saved");
    } else {
      setGpuState("idle");
      setError(result.error.message);
    }
  }

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

      {appInfo?.app === "web" ? (
        <p className="field-hint">
          Browser preview: secrets are kept in memory for this session and are never written to
          disk. Use the desktop build for stored credentials and in-app updates.
        </p>
      ) : null}

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
          void saveVastKey();
        }}
      >
        <div>
          <h2>vast.ai API key</h2>
          <p className="lede">
            Required to rent real GPUs. Stored in the operating-system credential vault; until a key
            is saved, sessions run against a simulated GPU so you can still exercise the flow.
          </p>
          <label className="field">
            <span>API key</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={credentialStatus?.vastai ? "saved — enter a new key to replace" : "paste your vast.ai key"}
              value={vastKey}
              onChange={(event) => setVastKey(event.target.value)}
            />
          </label>
          <p className="field-hint">
            Status: {credentialStatus?.vastai ? "key stored" : "no key stored — simulated GPU only"}
          </p>
          {vastMessage ? <p className="field-hint">{vastMessage}</p> : null}
          {vastError ? <p className="field-error">{vastError}</p> : null}
        </div>
        <div className="update-actions">
          <button type="submit" disabled={!bridgeAvailable || vastKey.trim().length === 0}>
            Save key
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={!bridgeAvailable}
            onClick={() => void testVastKey()}
          >
            Test connection
          </button>
        </div>
      </form>

      <form
        className="settings-card settings-card-stacked"
        onSubmit={(event) => {
          event.preventDefault();
          void saveHuggingFaceToken();
        }}
      >
        <div>
          <h2>Hugging Face access token</h2>
          <p className="lede">
            Stored with the operating-system credential vault and used for gated models and live
            catalogue refreshes. The public catalogue works without a token. Gated models only
            download when this token belongs to the Hugging Face account that accepted the model’s
            terms.
          </p>
          <label className="field">
            <span>Token</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={credentialStatus?.huggingface ? "saved — enter a new token to replace" : "hf_…"}
              value={hfToken}
              onChange={(event) => setHfToken(event.target.value)}
            />
          </label>
          <p className="field-hint">
            Status: {credentialStatus?.huggingface ? "token stored" : "no token stored"}
          </p>
          {hfMessage ? <p className="field-hint">{hfMessage}</p> : null}
          {hfError ? <p className="field-error">{hfError}</p> : null}
        </div>
        <div className="update-actions">
          <button type="submit" disabled={!bridgeAvailable || hfToken.trim().length === 0}>
            Save token
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={!bridgeAvailable}
            onClick={() => void testHuggingFaceToken()}
          >
            Test connection
          </button>
        </div>
      </form>

      <form
        className="settings-card settings-card-stacked"
        onSubmit={(event) => {
          event.preventDefault();
          void saveGpuFilters();
        }}
      >
        <div>
          <h2>GPU preferences</h2>
          <p className="lede">
            Applied whenever Maia ranks GPUs for a model. The startup gates are on by default: a
            cold start downloads about 25 GB (container image plus model weights), so a slow host
            turns a two-minute boot into a ten-minute one. Leave a gate empty to disable it.
          </p>
          <label className="field">
            <span>Countries (ISO codes, comma separated)</span>
            <input
              type="text"
              placeholder="e.g. IT, DE"
              value={countries}
              onChange={(event) => setCountries(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Trusted datacenters (comma separated, partial match)</span>
            <input
              type="text"
              placeholder="e.g. trusted-it, trusted-us"
              value={datacenters}
              onChange={(event) => setDatacenters(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Minimum reliability (0–1)</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.01"
              placeholder="any"
              value={minReliability}
              onChange={(event) => setMinReliability(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Maximum hourly price (USD)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="no ceiling"
              value={maxHourlyUsd}
              onChange={(event) => setMaxHourlyUsd(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Minimum download speed (Mbps)</span>
            <input
              type="number"
              min="0"
              step="50"
              placeholder={String(DEFAULT_MIN_DOWNLOAD_MBPS)}
              value={minDownloadMbps}
              onChange={(event) => {
                setMinDownloadMbps(event.target.value);
                setGpuState("idle");
              }}
            />
          </label>
          <label className="field">
            <span>Minimum upload speed (Mbps)</span>
            <input
              type="number"
              min="0"
              step="50"
              placeholder={String(DEFAULT_MIN_UPLOAD_MBPS)}
              value={minUploadMbps}
              onChange={(event) => {
                setMinUploadMbps(event.target.value);
                setGpuState("idle");
              }}
            />
          </label>
          <label className="field">
            <span>Minimum disk speed (MB/s)</span>
            <input
              type="number"
              min="0"
              step="50"
              placeholder={String(DEFAULT_MIN_DISK_BANDWIDTH_MBPS)}
              value={minDiskMBps}
              onChange={(event) => {
                setMinDiskMBps(event.target.value);
                setGpuState("idle");
              }}
            />
          </label>
          <label className="field">
            <span>GPU startup retries after the first attempt (0–10)</span>
            <input
              type="number"
              min="0"
              max="10"
              step="1"
              value={gpuStartupRetries}
              onChange={(event) => {
                setGpuStartupRetries(event.target.value);
                setGpuState("idle");
              }}
            />
          </label>
          <label className="field">
            <span>Warn me when the vast.ai balance falls below (USD)</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={walletWarnUsd}
              onChange={(event) => {
                setWalletWarnUsd(event.target.value);
                setGpuState("idle");
              }}
            />
          </label>
          <p className="field-hint">
            Maia also requires a GPU that vLLM supports (compute capability 7.5 or newer) and that
            vast.ai reports as rentable at booking time. Each retry books a different machine and
            logs the error that caused the switch.
          </p>
          {gpuState === "saved" ? <p className="field-hint">GPU preferences saved.</p> : null}
        </div>
        <div className="update-actions">
          <button type="submit" disabled={!bridgeAvailable || gpuState === "saving"}>
            {gpuState === "saving" ? "Saving…" : "Save GPU preferences"}
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={!bridgeAvailable}
            onClick={() => {
              applyGpuFilters(DEFAULT_GPU_FILTERS);
              void saveGpuFilters(DEFAULT_GPU_FILTERS);
            }}
          >
            Clear filters
          </button>
        </div>
      </form>

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
            Maia mirrors its log to the MaiaLLM telemetry service on the configured host, so a
            packaged build can be observed live. Logs never include prompts, responses, or
            credentials. Point this at your own backend when you self-host one.
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
