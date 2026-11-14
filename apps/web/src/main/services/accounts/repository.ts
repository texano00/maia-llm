import { randomUUID } from "node:crypto";
import type { DatabaseConnection } from "../../storage/db";

/** What happened, for the throttle windows and the audit trail. */
export type AuthEventKind =
  | "code_requested"
  | "code_failed"
  | "code_verified"
  | "signed_out"
  | "throttled";

export interface AccountRow {
  id: string;
  email: string;
  created_at: string;
  last_seen_at: string | null;
}

export interface AccessCodeRow {
  id: string;
  email: string;
  code_hash: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  attempts: number;
}

export interface AuthSessionRow {
  id: string;
  account_id: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  user_agent: string | null;
}

/**
 * SQL for the access flow. No policy lives here: the service decides when a
 * code is valid, this class only reads and writes rows.
 */
export class AccountRepository {
  constructor(private readonly db: DatabaseConnection) {}

  findAccountByEmail(email: string): AccountRow | null {
    return (
      (this.db.prepare("SELECT * FROM accounts WHERE email = ?").get(email) as
        | AccountRow
        | undefined) ?? null
    );
  }

  findAccountById(id: string): AccountRow | null {
    return (
      (this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as
        | AccountRow
        | undefined) ?? null
    );
  }

  /** Called only after a code was verified: requesting a code reveals nothing. */
  createAccount(email: string, now: string): AccountRow {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO accounts (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
      .run(id, email, now, now);

    return { id, email, created_at: now, last_seen_at: now };
  }

  touchAccount(id: string, now: string): void {
    this.db.prepare("UPDATE accounts SET last_seen_at = ? WHERE id = ?").run(now, id);
  }

  /** Issuing a code supersedes every outstanding one for the same address. */
  issueCode(email: string, codeHash: string, issuedAt: string, expiresAt: string): void {
    const transaction = this.db.transaction(() => {
      this.db
        .prepare("UPDATE access_codes SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL")
        .run(issuedAt, email);

      this.db
        .prepare(
          `INSERT INTO access_codes (id, email, code_hash, issued_at, expires_at, consumed_at, attempts)
           VALUES (?, ?, ?, ?, ?, NULL, 0)`
        )
        .run(randomUUID(), email, codeHash, issuedAt, expiresAt);
    });

    transaction();
  }

  /** Newest code for the address, whatever its state; the service judges it. */
  latestCode(email: string): AccessCodeRow | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM access_codes WHERE email = ? ORDER BY issued_at DESC LIMIT 1"
        )
        .get(email) as AccessCodeRow | undefined) ?? null
    );
  }

  incrementCodeAttempts(id: string): number {
    this.db.prepare("UPDATE access_codes SET attempts = attempts + 1 WHERE id = ?").run(id);
    const row = this.db.prepare("SELECT attempts FROM access_codes WHERE id = ?").get(id) as
      | { attempts: number }
      | undefined;
    return row?.attempts ?? 0;
  }

  consumeCode(id: string, now: string): void {
    this.db.prepare("UPDATE access_codes SET consumed_at = ? WHERE id = ?").run(now, id);
  }

  createSession(input: {
    accountId: string;
    tokenHash: string;
    createdAt: string;
    expiresAt: string;
    userAgent: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO auth_sessions
           (id, account_id, token_hash, created_at, last_seen_at, expires_at, revoked_at, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(
        randomUUID(),
        input.accountId,
        input.tokenHash,
        input.createdAt,
        input.createdAt,
        input.expiresAt,
        input.userAgent
      );
  }

  findSessionByTokenHash(tokenHash: string): AuthSessionRow | null {
    return (
      (this.db.prepare("SELECT * FROM auth_sessions WHERE token_hash = ?").get(tokenHash) as
        | AuthSessionRow
        | undefined) ?? null
    );
  }

  slideSession(id: string, lastSeenAt: string, expiresAt: string): void {
    this.db
      .prepare("UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?")
      .run(lastSeenAt, expiresAt, id);
  }

  revokeSession(id: string, now: string): void {
    this.db
      .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(now, id);
  }

  revokeAllSessions(accountId: string, now: string): void {
    this.db
      .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL")
      .run(now, accountId);
  }

  recordEvent(kind: AuthEventKind, emailHash: string, ipHash: string, now: string): void {
    this.db
      .prepare(
        "INSERT INTO auth_events (id, kind, email_hash, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(randomUUID(), kind, emailHash, ipHash, now);
  }

  countEvents(
    kind: AuthEventKind,
    key: { emailHash?: string; ipHash?: string },
    since: string
  ): { count: number; oldestAt: string | null } {
    const clauses = ["kind = @kind", "created_at > @since"];
    const params: Record<string, string> = { kind, since };

    if (key.emailHash) {
      clauses.push("email_hash = @emailHash");
      params.emailHash = key.emailHash;
    }

    if (key.ipHash) {
      clauses.push("ip_hash = @ipHash");
      params.ipHash = key.ipHash;
    }

    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(created_at) AS oldest_at
         FROM auth_events WHERE ${clauses.join(" AND ")}`
      )
      .get(params) as { count: number; oldest_at: string | null } | undefined;

    return { count: row?.count ?? 0, oldestAt: row?.oldest_at ?? null };
  }

  /** Removes the identity; every scoped table cascades from here. */
  deleteAccount(accountId: string): void {
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
  }

  /** Audit rows are keyed by digest, so deletion recomputes the digest. */
  deleteEventsForEmail(emailHash: string): void {
    this.db.prepare("DELETE FROM auth_events WHERE email_hash = ?").run(emailHash);
  }

  deleteCodesForEmail(email: string): void {
    this.db.prepare("DELETE FROM access_codes WHERE email = ?").run(email);
  }

  /** Housekeeping: codes and events have no value once they are outside the windows. */
  prune(before: { codes: string; events: string }): void {
    this.db
      .prepare("DELETE FROM access_codes WHERE issued_at < ? AND (consumed_at IS NOT NULL OR expires_at < ?)")
      .run(before.codes, before.codes);
    this.db.prepare("DELETE FROM auth_events WHERE created_at < ?").run(before.events);
  }
}
