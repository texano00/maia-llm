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
   * The backend's verdict, which must be a positive "yes".
   *
   * A missing verdict is not a yes: a search result fetched live from the Hub, or
   * a row from a snapshot that predates the field, is exactly the model that fails
   * at start. "Only models I can run" therefore hides anything unproven, which is
   * what the label promises.
   */
  supported?: boolean | null | undefined;
  gated?: "none" | "auto" | "manual" | null | undefined;
}

export interface CredentialStatus {
  /**
   * A key is stored. Deliberately not "a key verified": a verification that fails
   * because the provider was unreachable must not empty somebody's catalogue, and
   * the start path still refuses a key the provider rejects.
   */
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
export function readinessFor(
  model: ReadinessModel,
  status: CredentialStatus,
  options: {
    /**
     * Whether the list carries any verdict at all.
     *
     * A Hub listing has none, and hiding everything because the backend was not the
     * source would be a worse lie than showing what the Hub returned. When the
     * catalogue does carry verdicts, anything without one is unproven and hidden.
     */
    verdictsAvailable?: boolean | undefined;
  } = {}
): Readiness {
  if (model.supported === false) {
    return {
      ready: false,
      reason: "no engine can serve this repository",
      section: null
    };
  }

  if (model.supported !== true && options.verdictsAvailable !== false) {
    return {
      ready: false,
      reason: "the catalogue has no verdict for this repository yet",
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
      reason: "no GPU can be rented until a working vast.ai key is saved",
      section: "vastai"
    };
  }

  return { ready: true, reason: null, section: null };
}

/** Convenience for the list, where only the verdict matters. */
export function readyFor(
  model: ReadinessModel,
  status: CredentialStatus,
  options: { verdictsAvailable?: boolean | undefined } = {}
): boolean {
  return readinessFor(model, status, options).ready;
}

/**
 * How many of the fetched models the filter is hiding, so the checkbox can say
 * what it is doing instead of silently shrinking the list.
 */
export function hiddenCount(
  models: ReadonlyArray<ReadinessModel>,
  status: CredentialStatus,
  options: { verdictsAvailable?: boolean | undefined } = {}
): number {
  return models.filter((model) => !readyFor(model, status, options)).length;
}

/** True when at least one row carries a verdict, i.e. the list came from a snapshot. */
export function hasVerdicts(models: ReadonlyArray<ReadinessModel>): boolean {
  return models.some((model) => typeof model.supported === "boolean");
}
