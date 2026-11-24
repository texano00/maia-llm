import { useEffect, useRef, useState } from "react";
import type { AppInfo } from "@maia/contracts";

/**
 * Build information: exactly two facts, channel and version. The previous panel
 * mixed update controls with desktop-only fields the web product cannot honour.
 */
export function InfoButton() {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent): void => {
      if (container.current && !container.current.contains(event.target as Node)) {
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

  useEffect(() => {
    if (!open || info !== null || failed) {
      return;
    }

    void window.maia?.invoke<AppInfo>("app.info").then((result) => {
      if (result?.ok) {
        setInfo(result.data);
      } else {
        setFailed(true);
      }
    });
  }, [failed, info, open]);

  const channel = info?.channel ?? (failed ? "not available" : "…");
  const version = info?.version ?? (failed ? "not available" : "…");

  return (
    <div className="info-menu" ref={container}>
      <button
        type="button"
        className="info-trigger"
        aria-label="Build information"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        i
      </button>

      {open ? (
        <div className="info-panel" role="dialog" aria-label="Build information">
          <p className="info-row">
            <span>Channel</span>
            <strong>{channel}</strong>
          </p>
          <p className="info-row">
            <span>Version</span>
            <strong>{version}</strong>
          </p>
        </div>
      ) : null}
    </div>
  );
}
