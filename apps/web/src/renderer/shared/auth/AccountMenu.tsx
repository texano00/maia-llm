import { useEffect, useRef, useState } from "react";
import { useAuth } from "./AuthProvider";

/**
 * The only place that can sign out or delete the account. Deletion is guarded by
 * a typed confirmation because it removes conversations, images and saved
 * provider keys.
 */
export function AccountMenu() {
  const { email, signOut, deleteAccount } = useAuth();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  async function handleSignOut(): Promise<void> {
    setBusy(true);
    setError(null);
    const ok = await signOut();
    setBusy(false);
    if (!ok) {
      setError("Signing out failed. Try again.");
      return;
    }

    setOpen(false);
  }

  async function handleDelete(): Promise<void> {
    if (confirmation !== "DELETE") {
      return;
    }

    setBusy(true);
    setError(null);
    const ok = await deleteAccount();
    setBusy(false);
    if (!ok) {
      setError("Deleting the account failed. Try again.");
    }
  }

  return (
    <div className="account-menu" ref={container}>
      <button
        type="button"
        className="account-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        title={email ?? "Account"}
      >
        <span aria-hidden="true">{email ? email.slice(0, 1).toUpperCase() : "?"}</span>
        <span className="account-trigger-email">{email ?? "Account"}</span>
      </button>

      {open ? (
        <div className="account-panel" role="menu">
          <p className="account-email">{email}</p>

          {deleting ? (
            <>
              <p className="field-hint">
                This removes your conversations, images, saved keys and sign-in record. Type DELETE to
                confirm.
              </p>
              <label className="field">
                <span>Confirmation</span>
                <input
                  type="text"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  placeholder="DELETE"
                  autoFocus
                />
              </label>
              <div className="account-actions">
                <button
                  type="button"
                  className="danger"
                  disabled={busy || confirmation !== "DELETE"}
                  onClick={() => void handleDelete()}
                >
                  {busy ? "Deleting…" : "Delete everything"}
                </button>
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() => {
                    setDeleting(false);
                    setConfirmation("");
                    setError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className="account-actions">
              <button type="button" onClick={() => void handleSignOut()} disabled={busy}>
                {busy ? "Signing out…" : "Sign out"}
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => setDeleting(true)}
                disabled={busy}
              >
                Delete account…
              </button>
            </div>
          )}

          {error ? <p className="field-error">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
