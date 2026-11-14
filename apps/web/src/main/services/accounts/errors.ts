import type { ErrorCode } from "@maia/contracts";

/**
 * Errors thrown by the access flow. The RPC registry maps `code`, `retryable`
 * and `details` into the `Result` envelope, so the page can say how long to
 * wait or that a new code is needed.
 */
export interface AccessErrorInit {
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export function accessError(
  code: ErrorCode,
  message: string,
  init: AccessErrorInit = {}
): Error {
  return Object.assign(new Error(message), {
    code,
    retryable: init.retryable ?? false,
    ...(init.details ? { details: init.details } : {})
  });
}

/** One message for every unusable code: it never says whether the address exists. */
export function invalidCodeError(details?: Record<string, unknown>): Error {
  return accessError(
    "VALIDATION_FAILED",
    "That code is not valid any more. Ask for a new one.",
    details ? { details } : {}
  );
}
