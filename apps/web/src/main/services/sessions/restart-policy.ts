import type { RuntimeValues, Session } from "@maia/contracts";

export interface RestartRefusal {
  code:
    | "NOT_FOUND"
    | "SESSION_CONFLICT"
    | "MODEL_NOT_READY"
    | "VALIDATION_FAILED"
    | "ESTIMATE_REQUIRED";
  message: string;
}

export interface RestartValidationInput {
  session: Session | null;
  values: RuntimeValues;
  current: RuntimeValues;
  /** The model's documented maximum, or the product ceiling when null. */
  contextWindowMax: number | null;
  concurrencyMax: number;
  /** 0 means the person chose no cap. */
  capMicroUsd: number;
  /** What this run has accrued so far. */
  accruedMicroUsd: number;
}

const MIN_CONTEXT = 4096;

/**
 * A restart is allowed only when it can be honest: a live run, no restart
 * already in flight, different values, values the model and card can accept,
 * and a session that has not already exhausted its cap. Pure, so the guards are
 * a unit test rather than a branch inside the orchestrator.
 */
export function validateRestart(
  input: RestartValidationInput
): { ok: true; values: RuntimeValues } | { ok: false; refusal: RestartRefusal } {
  const { session } = input;

  if (!session) {
    return {
      ok: false,
      refusal: { code: "NOT_FOUND", message: "That model is not running any more." }
    };
  }

  if (session.restart !== null) {
    return {
      ok: false,
      refusal: {
        code: "SESSION_CONFLICT",
        message: "This model is already restarting. Wait for it to finish."
      }
    };
  }

  if (session.state !== "ready" && session.state !== "active") {
    return {
      ok: false,
      refusal: {
        code: "MODEL_NOT_READY",
        message: "This model is not running; there is nothing to restart."
      }
    };
  }

  if (
    input.values.contextWindow === input.current.contextWindow &&
    input.values.maxConcurrentRequests === input.current.maxConcurrentRequests
  ) {
    return {
      ok: false,
      refusal: {
        code: "VALIDATION_FAILED",
        message: "Those values are already in force. Choose a different one to restart."
      }
    };
  }

  const ceiling = input.contextWindowMax;
  if (
    input.values.contextWindow < MIN_CONTEXT ||
    (ceiling !== null && input.values.contextWindow > ceiling)
  ) {
    return {
      ok: false,
      refusal: {
        code: "VALIDATION_FAILED",
        message:
          ceiling === null
            ? `The context window must be at least ${MIN_CONTEXT.toLocaleString()} tokens.`
            : `The context window must be between ${MIN_CONTEXT.toLocaleString()} and ${ceiling.toLocaleString()} tokens for this model.`
      }
    };
  }

  if (
    input.values.maxConcurrentRequests < 1 ||
    input.values.maxConcurrentRequests > Math.min(8, input.concurrencyMax)
  ) {
    return {
      ok: false,
      refusal: {
        code: "VALIDATION_FAILED",
        message: `This machine can serve between 1 and ${Math.min(8, input.concurrencyMax)} requests at once at that context.`
      }
    };
  }

  if (input.capMicroUsd > 0 && input.accruedMicroUsd >= input.capMicroUsd) {
    return {
      ok: false,
      refusal: {
        code: "ESTIMATE_REQUIRED",
        message: "This run reached its spending cap. Raise the cap or start a new run."
      }
    };
  }

  return { ok: true, values: input.values };
}
