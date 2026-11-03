import { useUpdates } from "../../shared/updates/UpdatesProvider";
import { describeUpdateStatus } from "../../shared/updates/UpdateToast";

export function SettingsPage() {
  const { appInfo, status, check, download, install } = useUpdates();
  const busy = status?.phase === "checking" || status?.phase === "downloading";

  return (
    <section>
      <p className="eyebrow">Settings</p>
      <h1>Providers and preferences</h1>
      <p className="lede">
        Hugging Face, vast.ai, and S3 credentials will be stored in the operating-system credential
        vault here.
      </p>

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
    </section>
  );
}
