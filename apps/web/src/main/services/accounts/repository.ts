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

  /**
   * Runs that are using a machine right now.
   *
   * The account predicate is in the SQL, not applied afterwards: a projection
   * that filtered in JavaScript would be one forgotten `filter` away from
   * showing somebody else's session.
   */
  activeRuns(accountId: string): DetailRun[] {
    const rows = this.db
      .prepare(
        `SELECT id, model_id, state, started_at, hourly_rate_microusd, gpu_name,
                instance_id, label
           FROM sessions
          WHERE account_id = ?
            AND state IN (${ACTIVE_SESSION_STATES.map(() => "?").join(", ")})
          ORDER BY started_at DESC`
      )
      .all(accountId, ...ACTIVE_SESSION_STATES) as SessionRow[];

    return rows.map((row) => toDetailRun(row));
  }

  /** Finished runs, newest first, with the total for the pager. */
  historyPage(
    accountId: string,
    query: { limit: number; offset: number }
  ): { total: number; runs: DetailRun[] } {
    const totalRow = this.db
      .prepare("SELECT COUNT(*) AS total FROM sessions WHERE account_id = ?")
      .get(accountId) as { total: number } | undefined;

    const rows = this.db
      .prepare(
        `SELECT id, model_id, state, started_at, ended_at, end_reason, runtime,
                hourly_rate_microusd, estimated_total_microusd, gpu_name,
                instance_id, label
           FROM sessions
          WHERE account_id = ?
          ORDER BY started_at DESC
          LIMIT ? OFFSET ?`
      )
      .all(accountId, query.limit, query.offset) as SessionRow[];

    return { total: totalRow?.total ?? 0, runs: rows.map((row) => toDetailRun(row)) };
  }

  /**
   * Token and outcome totals for one window, from the measurements the product
   * already records per run.
   */
  sessionMetricsSummary(
    accountId: string,
    windowDays: number,
    nowMs: number
  ): {
    runs: number;
    outputTokens: number;
    tokensPerSecond: number | null;
    outcomes: Record<string, number>;
  } {
    const since = new Date(nowMs - windowDays * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT m.outcome AS outcome,
                COUNT(*) AS runs,
                COALESCE(SUM(m.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(m.generation_ms), 0) AS generation_ms
           FROM session_metrics m
           JOIN sessions s ON s.id = m.session_id
          WHERE s.account_id = ? AND m.recorded_at >= ?
          GROUP BY m.outcome`
      )
      .all(accountId, since) as Array<{
      outcome: string;
      runs: number;
      output_tokens: number;
      generation_ms: number;
    }>;

    let runs = 0;
    let outputTokens = 0;
    let generationMs = 0;
    const outcomes: Record<string, number> = {};
    for (const row of rows) {
      runs += Number(row.runs);
      outputTokens += Number(row.output_tokens);
      generationMs += Number(row.generation_ms);
      outcomes[row.outcome] = Number(row.runs);
    }

    return {
      runs,
      outputTokens,
      tokensPerSecond: generationMs > 0 ? (outputTokens / generationMs) * 1000 : null,
      outcomes
    };
  }

  /** Money actually charged by the provider inside the window. */
  spendMicroUsd(accountId: string, windowDays: number, nowMs: number): number {
    const since = new Date(nowMs - windowDays * 86_400_000).toISOString();
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(c.amount_microusd), 0) AS total
           FROM cost_records c
           JOIN sessions s ON s.id = c.session_id
          WHERE s.account_id = ? AND c.kind = 'final' AND c.recorded_at >= ?`
      )
      .get(accountId, since) as { total: number } | undefined;

    return Number(row?.total ?? 0);
  }

  /** What this account has stored, as counts and a date range — never content. */
  storageCounts(accountId: string): {
    conversations: number;
    messages: number;
    images: number;
    oldestAt: string | null;
    newestAt: string | null;
  } {
    const conversations = this.db
      .prepare(
        `SELECT COUNT(*) AS total, MIN(created_at) AS oldest, MAX(updated_at) AS newest
           FROM conversations WHERE account_id = ?`
      )
      .get(accountId) as { total: number; oldest: string | null; newest: string | null } | undefined;

    const messages = this.db
      .prepare(
        `SELECT COUNT(*) AS total
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE c.account_id = ?`
      )
      .get(accountId) as { total: number } | undefined;

    const images = this.db
      .prepare("SELECT COUNT(*) AS total FROM conversation_images WHERE account_id = ?")
      .get(accountId) as { total: number } | undefined;

    return {
      conversations: Number(conversations?.total ?? 0),
      messages: Number(messages?.total ?? 0),
      images: Number(images?.total ?? 0),
      oldestAt: conversations?.oldest ?? null,
      newestAt: conversations?.newest ?? null
    };
  }

  /** Provider names with a stored credential. Never reads the ciphertext. */
  credentialHandles(accountId: string): Array<{
    provider: string;
    lastVerifiedAt: string | null;
    status: "valid" | "invalid" | "unknown";
  }> {
    const rows = this.db
      .prepare(
        `SELECT provider, last_verified_at, status
           FROM credential_handles
          WHERE account_id = ?
          ORDER BY provider`
      )
      .all(accountId) as Array<{
      provider: string;
      last_verified_at: string | null;
      status: "valid" | "invalid" | "unknown";
    }>;

    return rows.map((row) => ({
      provider: row.provider,
      lastVerifiedAt: row.last_verified_at,
      status: row.status
    }));
  }
}

interface SessionRow {
  id: string;
  model_id: string;
  state: string;
  started_at: string;
  ended_at?: string | null;
  end_reason?: string | null;
  hourly_rate_microusd: number;
  estimated_total_microusd?: number;
  gpu_name?: string | null;
  instance_id?: number | null;
  /** Carries the `maia:mock:` prefix for simulated runs. */
  label: string;
}

export interface DetailRun {
  id: string;
  modelId: string;
  state: string;
  endReason: string | null;
  startedAt: string;
  endedAt: string | null;
  hourlyRateMicroUsd: number;
  gpu: string | null;
  /** Provider machine, when the run has one; the id the console shows. */
  host: string | null;
  simulated: boolean;
}

/** The label is how the product already remembers "nothing was rented". */
function toDetailRun(row: SessionRow): DetailRun {
  const host =
    row.instance_id === null || row.instance_id === undefined ? null : String(row.instance_id);

  return {
    id: row.id,
    modelId: row.model_id,
    state: row.state,
    endReason: row.end_reason ?? null,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    hourlyRateMicroUsd: row.hourly_rate_microusd,
    gpu: row.gpu_name ?? null,
    host,
    simulated: row.label.startsWith("maia:mock:")
  };
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
