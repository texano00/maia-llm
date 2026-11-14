import { describe, expect, it } from "vitest";
import type { AuthEventKind } from "../../src/main/services/accounts/repository";
import {
  AccessThrottle,
  MAX_ATTEMPTS_PER_CODE,
  THROTTLE_RULES,
  type ThrottleCounter
} from "../../src/main/services/accounts/throttle";

interface Recorded {
  kind: AuthEventKind;
  emailHash: string;
  ipHash: string;
  at: string;
}

/** In-memory stand-in for `AccountRepository.countEvents`. */
class FakeCounter implements ThrottleCounter {
  readonly events: Recorded[] = [];

  record(kind: AuthEventKind, emailHash: string, ipHash: string, at: number): void {
    this.events.push({ kind, emailHash, ipHash, at: new Date(at).toISOString() });
  }

  countEvents(
    kind: AuthEventKind,
    key: { emailHash?: string; ipHash?: string },
    since: string
  ): { count: number; oldestAt: string | null } {
    const rows = this.events
      .filter((event) => event.kind === kind && event.at > since)
      .filter((event) => (key.emailHash ? event.emailHash === key.emailHash : true))
      .filter((event) => (key.ipHash ? event.ipHash === key.ipHash : true))
      .sort((left, right) => left.at.localeCompare(right.at));

    return { count: rows.length, oldestAt: rows[0]?.at ?? null };
  }
}

const EMAIL = "e".repeat(64);
const OTHER_EMAIL = "f".repeat(64);
const ADDRESS = "a".repeat(64);

describe("AccessThrottle", () => {
  it("blocks the fourth code request for one address inside the window", () => {
    const counter = new FakeCounter();
    const clock = Date.parse("2026-11-14T10:00:00.000Z");
    const throttle = new AccessThrottle(counter, () => clock);

    for (let index = 0; index < THROTTLE_RULES.codeRequestPerEmail.limit; index += 1) {
      expect(throttle.checkCodeRequest(EMAIL, ADDRESS).allowed).toBe(true);
      counter.record("code_requested", EMAIL, ADDRESS, clock);
    }

    const blocked = throttle.checkCodeRequest(EMAIL, ADDRESS);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(800);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(900);
  });

  it("frees the window once the oldest request falls out of it", () => {
    const counter = new FakeCounter();
    let clock = Date.parse("2026-11-14T10:00:00.000Z");
    const throttle = new AccessThrottle(counter, () => clock);

    for (let index = 0; index < THROTTLE_RULES.codeRequestPerEmail.limit; index += 1) {
      counter.record("code_requested", EMAIL, ADDRESS, clock);
    }

    expect(throttle.checkCodeRequest(EMAIL, ADDRESS).allowed).toBe(false);

    clock += THROTTLE_RULES.codeRequestPerEmail.windowSeconds * 1_000 + 1;
    expect(throttle.checkCodeRequest(EMAIL, ADDRESS).allowed).toBe(true);
  });

  it("limits one source address even when the addresses differ", () => {
    const counter = new FakeCounter();
    const clock = Date.parse("2026-11-14T10:00:00.000Z");
    const throttle = new AccessThrottle(counter, () => clock);

    for (let index = 0; index < THROTTLE_RULES.codeRequestPerAddress.limit; index += 1) {
      counter.record("code_requested", `${index}`.padEnd(64, "0"), ADDRESS, clock);
    }

    expect(throttle.checkCodeRequest(OTHER_EMAIL, ADDRESS).allowed).toBe(false);
    // A different source still gets its own per-email allowance.
    expect(throttle.checkCodeRequest(OTHER_EMAIL, "b".repeat(64)).allowed).toBe(true);
  });

  it("limits wrong codes per address", () => {
    const counter = new FakeCounter();
    const clock = Date.parse("2026-11-14T10:00:00.000Z");
    const throttle = new AccessThrottle(counter, () => clock);

    for (let index = 0; index < THROTTLE_RULES.failedCodePerEmail.limit; index += 1) {
      counter.record("code_failed", EMAIL, ADDRESS, clock);
    }

    expect(throttle.checkFailedCode(EMAIL).allowed).toBe(false);
    expect(throttle.checkFailedCode(OTHER_EMAIL).allowed).toBe(true);
  });

  it("documents five attempts per issued code", () => {
    expect(MAX_ATTEMPTS_PER_CODE).toBe(5);
  });
});
