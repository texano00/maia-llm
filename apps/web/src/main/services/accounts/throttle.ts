import type { AuthEventKind } from "./repository";

/**
 * Windowed limits for the access flow (contracts/auth-api.md). Kept in one
 * place so the contract, the tests and the messages agree.
 */
export interface ThrottleRule {
  limit: number;
  windowSeconds: number;
}

export const THROTTLE_RULES = {
  codeRequestPerEmail: { limit: 3, windowSeconds: 15 * 60 },
  codeRequestPerAddress: { limit: 10, windowSeconds: 15 * 60 },
  failedCodePerEmail: { limit: 10, windowSeconds: 15 * 60 },
  verificationPerAddress: { limit: 20, windowSeconds: 15 * 60 }
} as const satisfies Record<string, ThrottleRule>;

/** Wrong attempts allowed against one issued code (contracts/auth-api.md). */
export const MAX_ATTEMPTS_PER_CODE = 5;

export interface ThrottleDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface ThrottleCount {
  count: number;
  /** Oldest event still inside the window; null when the count is 0. */
  oldestAt: string | null;
}

/** Storage port: the repository answers, so tests can use an array. */
export interface ThrottleCounter {
  countEvents(
    kind: AuthEventKind,
    key: { emailHash?: string; ipHash?: string },
    since: string
  ): ThrottleCount;
}

const ALLOWED: ThrottleDecision = { allowed: true, retryAfterSeconds: 0 };

/**
 * Checks the request before anything is written or sent. A blocked request
 * reports how long to wait, derived from the oldest event still in the window,
 * so the message is stable across retries.
 */
export class AccessThrottle {
  constructor(
    private readonly counter: ThrottleCounter,
    private readonly now: () => number = () => Date.now()
  ) {}

  checkCodeRequest(emailHash: string, ipHash: string): ThrottleDecision {
    return this.firstBlocked([
      { event: "code_requested", key: { emailHash }, rule: THROTTLE_RULES.codeRequestPerEmail },
      { event: "code_requested", key: { ipHash }, rule: THROTTLE_RULES.codeRequestPerAddress }
    ]);
  }

  checkFailedCode(emailHash: string): ThrottleDecision {
    return this.firstBlocked([
      { event: "code_failed", key: { emailHash }, rule: THROTTLE_RULES.failedCodePerEmail }
    ]);
  }

  checkVerification(ipHash: string): ThrottleDecision {
    return this.firstBlocked([
      { event: "code_verified", key: { ipHash }, rule: THROTTLE_RULES.verificationPerAddress }
    ]);
  }

  private firstBlocked(
    checks: Array<{
      event: AuthEventKind;
      key: { emailHash?: string; ipHash?: string };
      rule: ThrottleRule;
    }>
  ): ThrottleDecision {
    const now = this.now();
    let wait = 0;

    for (const check of checks) {
      const since = new Date(now - check.rule.windowSeconds * 1_000).toISOString();
      const { count, oldestAt } = this.counter.countEvents(check.event, check.key, since);
      if (count < check.rule.limit) {
        continue;
      }

      const oldest = oldestAt ? Date.parse(oldestAt) : now;
      const elapsed = Math.max(now - oldest, 0);
      const remaining = Math.ceil((check.rule.windowSeconds * 1_000 - elapsed) / 1_000);
      wait = Math.max(wait, Math.max(remaining, 1));
    }

    return wait > 0 ? { allowed: false, retryAfterSeconds: wait } : ALLOWED;
  }
}
