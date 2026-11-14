import { randomUUID } from "node:crypto";
import type { AccountSummary, Capability } from "@maia/contracts";
import type { DatabaseConnection } from "../../storage/db";
import { effectiveCapabilities, storedCapabilities } from "./capabilities";

/** Session states that mean "this account is using the product right now". */
const ACTIVE_SESSION_STATES = ["estimated", "provisioning", "ready", "active", "ending"];

/** Raised when a revocation would leave nobody able to grant it back. */
export class LastOperatorError extends Error {
  constructor() {
    super("The last operator cannot revoke its own capability");
    this.name = "LastOperatorError";
  }
}

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

  /** Effective capabilities: what the product and the portal act on. */
  capabilitiesOf(accountId: string): Capability[] {
    return effectiveCapabilities(this.storedCapabilitiesOf(accountId));
  }

  /** The grant list exactly as written, without the `operator → debug` implication. */
  storedCapabilitiesOf(accountId: string): Capability[] {
    const row = this.db
      .prepare("SELECT capabilities_json FROM accounts WHERE id = ?")
      .get(accountId) as { capabilities_json: string | null } | undefined;
    return storedCapabilities(parseCapabilitiesJson(row?.capabilities_json ?? null));
  }

  /** Stores the grant list as given; `operator` still implies `debug` on read. */
  setCapabilities(accountId: string, capabilities: readonly Capability[]): void {
    const stored = [...new Set(capabilities)];
    this.db
      .prepare("UPDATE accounts SET capabilities_json = ? WHERE id = ?")
      .run(JSON.stringify(stored), accountId);
  }

  countOperators(): number {
    const rows = this.db
      .prepare("SELECT capabilities_json FROM accounts")
      .all() as Array<{ capabilities_json: string | null }>;
    return rows.filter((row) =>
      effectiveCapabilities(parseCapabilitiesJson(row.capabilities_json)).includes("operator")
    ).length;
  }

  /**
   * Grants are additive and idempotent: signing in again must not fail because
   * the capability is already there.
   */
  grantCapability(accountId: string, capability: Capability): Capability[] {
    const current = this.storedCapabilitiesOf(accountId);
    if (!current.includes(capability)) {
      this.setCapabilities(accountId, [...current, capability]);
    }
    return this.capabilitiesOf(accountId);
  }

  /**
   * Revoking the last operator would lock the portal out of itself, so the
   * guard lives here, inside the transaction that also writes the row.
   */
  revokeCapability(accountId: string, capability: Capability): Capability[] {
    const transaction = this.db.transaction(() => {
      const current = this.storedCapabilitiesOf(accountId);
      if (!current.includes(capability)) {
        return this.capabilitiesOf(accountId);
      }
      if (capability === "operator" && this.countOperators() <= 1) {
        throw new LastOperatorError();
      }
      // Only the named grant goes: an explicitly granted `debug` survives.
      this.setCapabilities(
        accountId,
        current.filter((entry) => entry !== capability)
      );
      return this.capabilitiesOf(accountId);
    });

    return transaction();
  }

  /** One account's projection, for the answer to a capability change. */
  accountSummary(accountId: string): AccountSummary | null {
    const row = this.db
      .prepare(
        `SELECT a.id, a.email, a.created_at, a.last_seen_at, a.capabilities_json,
                (SELECT COUNT(*) FROM sessions s
                  WHERE s.account_id = a.id
                    AND s.state IN (${ACTIVE_SESSION_STATES.map(() => "?").join(", ")}))
                  AS active_sessions
           FROM accounts a
          WHERE a.id = ?`
      )
      .get(...ACTIVE_SESSION_STATES, accountId) as
      | {
          id: string;
          email: string;
          created_at: string;
          last_seen_at: string | null;
          capabilities_json: string | null;
          active_sessions: number;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      email: row.email,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      capabilities: effectiveCapabilities(parseCapabilitiesJson(row.capabilities_json)),
      activeSessions: row.active_sessions
    };
  }

  /** Portal listing: identity, capabilities and how busy the account is. */
  listAccountSummaries(query: {
    search?: string;
    limit: number;
    offset: number;
  }): { total: number; accounts: AccountSummary[] } {
    const where = query.search ? "WHERE lower(email) LIKE @like" : "";
    const params: Record<string, string | number> = {
      like: `%${(query.search ?? "").toLowerCase()}%`,
      limit: query.limit,
      offset: query.offset
    };

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM accounts ${where}`)
      .get(params) as { total: number } | undefined;

    const rows = this.db
      .prepare(
        `SELECT a.id, a.email, a.created_at, a.last_seen_at, a.capabilities_json,
                (SELECT COUNT(*) FROM sessions s
                  WHERE s.account_id = a.id
                    AND s.state IN (${ACTIVE_SESSION_STATES.map(() => "?").join(", ")}))
                  AS active_sessions
           FROM accounts a
           ${where}
          ORDER BY a.created_at DESC
          LIMIT @limit OFFSET @offset`
      )
      .all(...ACTIVE_SESSION_STATES, params) as Array<{
      id: string;
      email: string;
      created_at: string;
      last_seen_at: string | null;
      capabilities_json: string | null;
      active_sessions: number;
    }>;

    return {
      total: totalRow?.total ?? 0,
      accounts: rows.map((row) => ({
        id: row.id,
        email: row.email,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        capabilities: effectiveCapabilities(parseCapabilitiesJson(row.capabilities_json)),
        activeSessions: row.active_sessions
      }))
    };
  }
}

/** A row written before migration 0013, or by hand, must not break a sign-in. */
function parseCapabilitiesJson(raw: string | null): unknown {
  if (!raw) {
    return [];
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
}
