/**
 * What "I can run this" means, in one place.
 *
 * The catalogue used to filter on the backend's global `supported` flag, which
 * answers "could anybody run this" — so a gated model appeared for a person with
 * no Hugging Face token and failed at start, and the list disagreed with the
 * start button. The list and the button now call this function, so they cannot
 * drift apart.
 */

export interface ReadinessModel {
  /**
   * The backend's verdict. Absent on snapshots that predate the field; an
   * unknown verdict is not a refusal, so nothing startable is ever hidden.
   */
  supported?: boolean | null | undefined;
  gated?: "none" | "auto" | "manual" | null | undefined;
}

export interface CredentialStatus {
  huggingface: boolean;
  vastai: boolean;
}

export interface Readiness {
  ready: boolean;
  /** Why it is not ready, in one sentence; null when it is. */
  reason: string | null;
  /** The settings section that fixes it, when a credential is the cause. */
  section: "huggingface" | "vastai" | null;
}

/**
 * A model is ready when the backend can serve it *and* nothing is missing on
 * this person's account. Gated repositories need a token before the download is
 * allowed, and no GPU can be rented without a vast.ai key.
 */
export function readinessFor(model: ReadinessModel, status: CredentialStatus): Readiness {
  if (model.supported === false) {
    return {
      ready: false,
      reason: "no engine can serve this repository",
      section: null
    };
  }

  if (model.gated === "auto" || model.gated === "manual") {
    if (!status.huggingface) {
      return {
        ready: false,
        reason: "this repository is gated and needs a Hugging Face token",
        section: "huggingface"
      };
    }
  }

  if (!status.vastai) {
    return {
      ready: false,
      reason: "no GPU can be rented until a vast.ai key is saved",
      section: "vastai"
    };
  }

  return { ready: true, reason: null, section: null };
}

/** Convenience for the list, where only the verdict matters. */
export function readyFor(model: ReadinessModel, status: CredentialStatus): boolean {
  return readinessFor(model, status).ready;
}

/**
 * How many of the fetched models the filter is hiding, so the checkbox can say
 * what it is doing instead of silently shrinking the list.
 */
export function hiddenCount(
  models: ReadonlyArray<ReadinessModel>,
  status: CredentialStatus
): number {
  return models.filter((model) => !readyFor(model, status)).length;
}
