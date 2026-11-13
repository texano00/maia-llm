import { useEffect, useRef, useState } from "react";
import { describeUpdateStatus } from "./updates/UpdateToast";
import { useUpdates } from "./updates/UpdatesProvider";

/**
 * The only chrome in the top bar: a single info button that reveals the
 * installed version and runtime details.
 */
export function InfoButton() {
  const { appInfo, status, bridgeAvailable, lastError, check, download, install } = useUpdates();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const busy =
    status?.phase === "checking" ||
    status?.phase === "downloading" ||
    status?.phase === "installing";

  return (
    <div className="info" ref={containerRef}>
      <button
        type="button"
        className={bridgeAvailable ? "icon-button" : "icon-button icon-button-warning"}
        aria-label="Application information"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={bridgeAvailable ? "Application information" : "Application bridge unavailable"}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M12 10.5v6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <circle cx="12" cy="7.6" r="1.05" fill="currentColor" />
        </svg>
      </button>

      {open ? (
        <div className="info-popover" role="dialog" aria-label="Application information">
          <p className="info-title">Maia LLM</p>
          <dl className="info-list">
            <InfoRow label="Version" value={appInfo?.app ?? status?.currentVersion ?? "—"} />
            <InfoRow label="Channel" value={status?.channel ?? appInfo?.channel ?? "stable"} />
            <InfoRow label="Electron" value={appInfo?.electron ?? "—"} />
            <InfoRow label="Chromium" value={appInfo?.chrome ?? "—"} />
            <InfoRow label="Node" value={appInfo?.node ?? "—"} />
            <InfoRow
              label="Platform"
              value={appInfo ? `${appInfo.platform} ${appInfo.arch}` : "—"}
            />
            <InfoRow
              label="Install"
              value={appInfo ? (appInfo.packaged ? "Packaged release" : "Development build") : "—"}
            />
          </dl>

          <div className="info-update">
            <span>{describeUpdateStatus(status)}</span>
            {status?.phase === "available" ? (
              <button type="button" className="ghost-button" onClick={() => void download()}>
                Update now
              </button>
            ) : status?.phase === "ready" ? (
              <button type="button" className="ghost-button" onClick={() => void install()}>
                Restart and install
              </button>
            ) : status?.phase === "installing" ? (
              <button type="button" className="ghost-button" disabled>
                Installing…
              </button>
            ) : (
              <button
                type="button"
                className="ghost-button"
                disabled={!bridgeAvailable || busy || (status !== null && !status.supported)}
                onClick={() => void check()}
              >
                {status?.phase === "checking" ? "Checking…" : "Check for updates"}
              </button>
            )}
            {lastError ? <span className="info-error">{lastError}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
