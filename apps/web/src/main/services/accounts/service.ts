import {
  ACCESS_CODE_LENGTH,
  ACCESS_CODE_TTL_SECONDS,
  ACCESS_RESEND_SECONDS,
  ACCESS_SESSION_DAYS,
  type AuthConfig,
  type AuthDeleteAccount,
  type AuthRequestCode,
  type AuthRequestCodeResult,
  type AuthState,
  type AuthVerifyCode,
  type AuthVerifyCodeResult
} from "@maia/contracts";
import {
  digestsEqual,
  generateAccessCode,
  generateSessionToken,
  hashCode,
  hashIdentifier,
  hashSessionToken,
  normalizeEmail
} from "./crypto";
import { accessError, invalidCodeError } from "./errors";
import type { Mailer } from "./mailer";
import type { AccountRepository, AuthSessionRow } from "./repository";
import { AccessThrottle, MAX_ATTEMPTS_PER_CODE } from "./throttle";
import type { CaptchaVerifier } from "./turnstile";

export interface AccessRequestContext {
  /** Socket peer address, or `CF-Connecting-IP` when the proxy is trusted. */
  sourceAddress: string;
  userAgent?: string | null;
}

export interface AccessServiceOptions {
  repository: AccountRepository;
  mailer: Mailer;
  captcha: CaptchaVerifier;
  /** Pepper for code digests; also makes old sessions unusable when rotated. */
  sessionSecret: string;
  codeTtlSeconds?: number;
  sessionDays?: number;
  now?: () => number;
}

export interface VerifiedSession {
  result: AuthVerifyCodeResult;
  token: string;
  expiresAt: string;
}

const HOUR_MS = 60 * 60 * 1_000;

/**
 * Passwordless entry. Every branch that can be reached with an unknown address
 * produces the same response as the known-address branch, so the page cannot be
 * used to enumerate accounts.
 */
export class AccessService {
  private readonly repository: AccountRepository;
  private readonly mailer: Mailer;
  private readonly captcha: CaptchaVerifier;
  private readonly sessionSecret: string;
  private readonly codeTtlSeconds: number;
  private readonly sessionDays: number;
  private readonly now: () => number;
  private readonly throttle: AccessThrottle;

  constructor(options: AccessServiceOptions) {
    this.repository = options.repository;
    this.mailer = options.mailer;
    this.captcha = options.captcha;
    this.sessionSecret = options.sessionSecret;
    this.codeTtlSeconds = options.codeTtlSeconds ?? ACCESS_CODE_TTL_SECONDS;
    this.sessionDays = options.sessionDays ?? ACCESS_SESSION_DAYS;
    this.now = options.now ?? (() => Date.now());
    this.throttle = new AccessThrottle(options.repository, this.now);
  }

  config(): AuthConfig {
    return {
      captcha: this.captcha.siteKey
        ? { provider: "turnstile" as const, siteKey: this.captcha.siteKey }
        : null,
      codeLength: ACCESS_CODE_LENGTH,
      codeTtlSeconds: this.codeTtlSeconds,
      resendAfterSeconds: ACCESS_RESEND_SECONDS,
      emailDelivery: this.mailer.kind
    };
  }

  /** Resolves the cookie without revealing whether it ever existed. */
  state(token: string | null): AuthState {
    const resolved = this.resolve(token);
    if (!resolved) {
      return { signedIn: false };
    }

    return {
      signedIn: true,
      email: resolved.account.email,
      createdAt: resolved.account.created_at,
      expiresAt: resolved.session.expires_at
    };
  }

  /** Account id for a valid cookie, or null. Used by the transport to route. */
  accountFor(token: string | null): string | null {
    return this.resolve(token)?.account.id ?? null;
  }

  async requestCode(input: AuthRequestCode, context: AccessRequestContext): Promise<AuthRequestCodeResult> {
    const email = normalizeEmail(input.email);
    const emailHash = hashIdentifier(email);
    const ipHash = hashIdentifier(context.sourceAddress);

    const blocked = this.throttle.checkCodeRequest(emailHash, ipHash);
    if (!blocked.allowed) {
      this.repository.recordEvent("throttled", emailHash, ipHash, this.iso());
      throw accessError(
        "RATE_LIMITED",
        `Too many codes requested. Try again in ${formatWait(blocked.retryAfterSeconds)}.`,
        { retryable: true, details: { retryAfterSeconds: blocked.retryAfterSeconds } }
      );
    }

    if (this.captcha.siteKey !== null) {
      const verdict = await this.captcha.verify(input.captchaToken, context.sourceAddress);
      if (!verdict.ok) {
        if (verdict.reason === "unavailable") {
          throw accessError(
            "PROVIDER_UNAVAILABLE",
            "The captcha could not be checked. Try again in a moment.",
            { retryable: true }
          );
        }

        throw accessError("VALIDATION_FAILED", "Complete the captcha and try again.");
      }
    }

    const code = generateAccessCode();
    const issuedAt = this.iso();
    const expiresAt = new Date(this.now() + this.codeTtlSeconds * 1_000).toISOString();

    this.repository.issueCode(email, hashCode(this.sessionSecret, email, code), issuedAt, expiresAt);
    // Recorded before delivery: a broken mail provider must not become a way to
    // send unlimited requests.
    this.repository.recordEvent("code_requested", emailHash, ipHash, issuedAt);
    await this.mailer.send({ to: email, code });

    return { sent: true, resendAfterSeconds: ACCESS_RESEND_SECONDS };
  }

  async verifyCode(input: AuthVerifyCode, context: AccessRequestContext): Promise<VerifiedSession> {
    const email = normalizeEmail(input.email);
    const emailHash = hashIdentifier(email);
    const ipHash = hashIdentifier(context.sourceAddress);

    const sourceBlocked = this.throttle.checkVerification(ipHash);
    if (!sourceBlocked.allowed) {
      throw accessError(
        "RATE_LIMITED",
        `Too many attempts. Try again in ${formatWait(sourceBlocked.retryAfterSeconds)}.`,
        { retryable: true, details: { retryAfterSeconds: sourceBlocked.retryAfterSeconds } }
      );
    }

    const emailBlocked = this.throttle.checkFailedCode(emailHash);
    if (!emailBlocked.allowed) {
      throw accessError(
        "RATE_LIMITED",
        `Too many wrong codes. Try again in ${formatWait(emailBlocked.retryAfterSeconds)}.`,
        { retryable: true, details: { retryAfterSeconds: emailBlocked.retryAfterSeconds } }
      );
    }

    const row = this.repository.latestCode(email);
    if (!row || row.consumed_at !== null || Date.parse(row.expires_at) <= this.now()) {
      throw invalidCodeError();
    }

    if (row.attempts >= MAX_ATTEMPTS_PER_CODE) {
      throw invalidCodeError({ requiresNewCode: true });
    }

    const expected = hashCode(this.sessionSecret, email, input.code);
    if (!digestsEqual(expected, row.code_hash)) {
      const attempts = this.repository.incrementCodeAttempts(row.id);
      this.repository.recordEvent("code_failed", emailHash, ipHash, this.iso());

      if (attempts >= MAX_ATTEMPTS_PER_CODE) {
        this.repository.consumeCode(row.id, this.iso());
        throw accessError(
          "RATE_LIMITED",
          "That code is no longer valid. Ask for a new one.",
          { retryable: true, details: { requiresNewCode: true, retryAfterSeconds: ACCESS_RESEND_SECONDS } }
        );
      }

      throw invalidCodeError({ attemptsRemaining: MAX_ATTEMPTS_PER_CODE - attempts });
    }

    const now = this.iso();
    this.repository.consumeCode(row.id, now);

    const account =
      this.repository.findAccountByEmail(email) ?? this.repository.createAccount(email, now);
    this.repository.touchAccount(account.id, now);

    const token = generateSessionToken();
    const expiresAt = new Date(this.now() + this.sessionDays * 24 * HOUR_MS).toISOString();
    this.repository.createSession({
      accountId: account.id,
      tokenHash: hashSessionToken(token),
      createdAt: now,
      expiresAt,
      userAgent: context.userAgent?.slice(0, 200) ?? null
    });
    this.repository.recordEvent("code_verified", emailHash, ipHash, now);

    return { result: { signedIn: true, email: account.email }, token, expiresAt };
  }

  /** Revokes the row immediately: the same cookie value fails afterwards. */
  signOut(token: string | null): { signedOut: true } {
    if (token) {
      const session = this.repository.findSessionByTokenHash(hashSessionToken(token));
      if (session && session.revoked_at === null) {
        this.repository.revokeSession(session.id, this.iso());
        const account = this.repository.findAccountById(session.account_id);
        if (account) {
          this.repository.recordEvent(
            "signed_out",
            hashIdentifier(account.email),
            hashIdentifier("-"),
            this.iso()
          );
        }
      }
    }

    return { signedOut: true };
  }

  /**
   * Removes the identity and everything that hangs off it. The caller ends
   * running sessions and deletes image files first, because a database cascade
   * cannot stop a GPU.
   */
  deleteAccount(accountId: string, input: AuthDeleteAccount): { deleted: true } {
    if (input.confirmation !== "DELETE") {
      throw accessError("VALIDATION_FAILED", "Type DELETE to confirm.");
    }

    const account = this.repository.findAccountById(accountId);
    if (!account) {
      throw accessError("NOT_AUTHENTICATED", "This session is no longer valid.");
    }

    this.repository.revokeAllSessions(accountId, this.iso());
    this.repository.deleteCodesForEmail(account.email);
    this.repository.deleteEventsForEmail(hashIdentifier(account.email));
    this.repository.deleteAccount(accountId);

    return { deleted: true };
  }

  prune(): void {
    const now = this.now();
    this.repository.prune({
      codes: new Date(now - 24 * HOUR_MS).toISOString(),
      events: new Date(now - 30 * 24 * HOUR_MS).toISOString()
    });
  }

  private resolve(
    token: string | null
  ): { session: AuthSessionRow; account: { id: string; email: string; created_at: string } } | null {
    if (!token) {
      return null;
    }

    const session = this.repository.findSessionByTokenHash(hashSessionToken(token));
    if (!session || session.revoked_at !== null || Date.parse(session.expires_at) <= this.now()) {
      return null;
    }

    const account = this.repository.findAccountById(session.account_id);
    if (!account) {
      return null;
    }

    // Slide at most once an hour: a request per keystroke does not need a write.
    if (this.now() - Date.parse(session.last_seen_at) > HOUR_MS) {
      const lastSeenAt = this.iso();
      const expiresAt = new Date(this.now() + this.sessionDays * 24 * HOUR_MS).toISOString();
      this.repository.slideSession(session.id, lastSeenAt, expiresAt);
      return {
        session: { ...session, last_seen_at: lastSeenAt, expires_at: expiresAt },
        account
      };
    }

    return { session, account };
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

function formatWait(seconds: number): string {
  if (seconds <= 60) {
    return `${Math.max(seconds, 1)} seconds`;
  }

  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
