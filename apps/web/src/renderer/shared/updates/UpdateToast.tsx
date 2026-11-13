import { useState } from "react";
import type { UpdateStatus } from "@maia/contracts";
import { useUpdates } from "./UpdatesProvider";

/**
 * Top-right banner that appears as soon as a newer version is detected and
 * carries the update through download and restart without leaving the app.
 */
export function UpdateToast() {
  const { status, download, install } = useUpdates();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  if (!status || !status.supported) {
    return null;
  }

  const dismiss = (): void => setDismissedVersion(status.latestVersion ?? null);

  if (status.phase === "available" && status.latestVersion) {
    if (dismissedVersion === status.latestVersion) {
      return null;
    }

    return (
      <aside className="update-toast" role="status" aria-live="polite">
        <div className="update-toast-head">
          <span className="update-badge">Update</span>
          <strong>Version {status.latestVersion} is available</strong>
        </div>
        {status.releaseNotes ? <p className="update-notes">{status.releaseNotes}</p> : null}
        <div className="update-actions">
          <button type="button" onClick={() => void download()}>
            Update now
          </button>
          <button type="button" className="ghost-button" onClick={dismiss}>
            Later
          </button>
        </div>
      </aside>
    );
  }

  if (status.phase === "downloading") {
    const progress = Math.round(status.progressPercent ?? 0);

    return (
      <aside className="update-toast" role="status" aria-live="polite">
        <div className="update-toast-head">
          <span className="update-badge">Update</span>
          <strong>Downloading {status.latestVersion}</strong>
        </div>
        <div
          className="update-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
        <p className="update-meta">
          {progress}%{formatRate(status.bytesPerSecond)}
        </p>
      </aside>
    );
  }

  if (status.phase === "ready") {
    return (
      <aside className="update-toast" role="status" aria-live="polite">
        <div className="update-toast-head">
          <span className="update-badge">Update</span>
          <strong>Version {status.latestVersion} is ready</strong>
        </div>
        <p className="update-notes">Restart Maia LLM to finish installing the update.</p>
        <div className="update-actions">
          <button type="button" onClick={() => void install()}>
            Restart and install
          </button>
          <button type="button" className="ghost-button" onClick={dismiss}>
            Later
          </button>
        </div>
      </aside>
    );
  }

  if (status.phase === "installing") {
    return (
      <aside className="update-toast" role="status" aria-live="polite">
        <div className="update-toast-head">
          <span className="update-badge">Update</span>
          <strong>Installing {status.latestVersion}…</strong>
        </div>
        <div className="update-progress update-progress-indeterminate" aria-hidden="true">
          <span />
        </div>
        <p className="update-notes">
          Maia LLM closes to apply the update and reopens automatically. This can take a minute.
        </p>
      </aside>
    );
  }

  return null;
}

function formatRate(bytesPerSecond: number | undefined): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) {
    return "";
  }

  const megabytes = bytesPerSecond / (1024 * 1024);
  return ` · ${megabytes >= 1 ? `${megabytes.toFixed(1)} MB/s` : `${Math.round(bytesPerSecond / 1024)} KB/s`}`;
}

export function describeUpdateStatus(status: UpdateStatus | null): string {
  if (!status) {
    return "Not checked yet.";
  }

  if (!status.supported) {
    return "Updates are managed by the installed release.";
  }

  switch (status.phase) {
    case "idle":
      return "Not checked yet.";
    case "checking":
      return "Checking for updates…";
    case "up-to-date":
      return `Up to date (${status.currentVersion}).`;
    case "available":
      return `Version ${status.latestVersion} is available.`;
    case "downloading":
      return `Downloading ${status.latestVersion} (${Math.round(status.progressPercent ?? 0)}%)…`;
    case "ready":
      return `Version ${status.latestVersion} is ready to install.`;
    case "installing":
      return `Installing ${status.latestVersion}; the app will restart.`;
    case "error":
      return status.errorMessage ?? "Update check failed.";
    default:
      return "Not checked yet.";
  }
}
