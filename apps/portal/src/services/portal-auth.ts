import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { SqlDatabase } from "../db/database.js";

export interface IssuedCredentials {
  installationId: string;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

export interface TokenServiceOptions {
  db: SqlDatabase;
  /** HMAC key for access tokens; a deployment secret, never derived from data. */
  secret: string;
  accessTtlMs: number;
  refreshTtlMs: number;
  now?: () => number;
}

interface CredentialRow {
  id: string;
  installation_id: string;
  family_id: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Installation credentials.
 *
 * Access tokens are stateless HMAC tokens (≤60 minutes) so a request does not
 * hit the database; refresh tokens are opaque, stored hashed, rotated on every
 * use, and a replayed one revokes the whole family. That is what makes "revoke
 * this installation" mean something without a session table per request.
 */
export class TokenService {
  private readonly now: () => number;

  constructor(private readonly options: TokenServiceOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  async enroll(input: {
    installId: string;
    appVersion?: string | null | undefined;
    platform?: string | null | undefined;
  }): Promise<IssuedCredentials> {
    const now = this.now();
    const existing = (await this.options.db.query(
      `SELECT id, state FROM installations WHERE install_id = ?`,
      [input.installId]
    )) as unknown as Array<{ id: string; state: string }>;

    const installationId = existing[0]?.id ?? randomUUID();

    if (existing[0]) {
      if (existing[0].state !== "active") {
        // Re-enrolling a revoked installation keeps its identity but starts a
        // new credential epoch: every token issued before the revocation is
        // rejected from here on (`valid_from`), so nothing is resurrected.
        const timestamp = new Date(now).toISOString();
        await this.options.db.execute(
          `UPDATE installations SET state = 'active', revoked_at = NULL, last_seen_at = ?,
             app_version = COALESCE(?, app_version), platform = COALESCE(?, platform)
           WHERE id = ?`,
          [timestamp, input.appVersion ?? null, input.platform ?? null, installationId]
        );
        await this.audit("installation", installationId, "installation_reenrolled", input.installId);
        return this.issuePair(installationId, randomUUID(), now);
      }

      await this.options.db.execute(
        `UPDATE installations SET last_seen_at = ?, app_version = COALESCE(?, app_version),
           platform = COALESCE(?, platform) WHERE id = ?`,
        [new Date(now).toISOString(), input.appVersion ?? null, input.platform ?? null, installationId]
      );
    } else {
      return this.createInstallation(input, now);
    }

    return this.issuePair(installationId, randomUUID(), now);
  }

  async refresh(refreshToken: string): Promise<IssuedCredentials | null> {
    const digest = sha256(refreshToken);
    const rows = (await this.options.db.query(
      `SELECT id, installation_id, family_id, expires_at, used_at, revoked_at
         FROM installation_credentials WHERE token_hash = ?`,
      [digest]
    )) as unknown as CredentialRow[];
    const credential = rows[0];

    const now = this.now();

    if (!credential) {
      return null;
    }

    if (credential.revoked_at !== null) {
      return null;
    }

    if (credential.used_at !== null) {
      // Replay of an already-rotated token: assume theft and burn the family.
      await this.revokeFamily(credential.family_id, "refresh-reuse", now);
      await this.audit("credential", credential.installation_id, "refresh_reuse", credential.family_id);
      return null;
    }

    if (Date.parse(credential.expires_at) <= now) {
      return null;
    }

    const installation = (await this.options.db.query(
      `SELECT id, state FROM installations WHERE id = ?`,
      [credential.installation_id]
    )) as unknown as Array<{ id: string; state: string }>;

    if (!installation[0] || installation[0].state !== "active") {
      return null;
    }

    await this.options.db.execute(
      `UPDATE installation_credentials SET used_at = ? WHERE id = ?`,
      [new Date(now).toISOString(), credential.id]
    );
    await this.options.db.execute(`UPDATE installations SET last_seen_at = ? WHERE id = ?`, [
      new Date(now).toISOString(),
      credential.installation_id
    ]);

    return this.issuePair(credential.installation_id, credential.family_id, now);
  }

  /** Returns the installation id, or null when the token is invalid or expired. */
  async verifyAccess(token: string): Promise<string | null> {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "maia1") {
      return null;
    }

    const [, payload, signature] = parts as [string, string, string];
    const expected = createHmac("sha256", this.options.secret).update(payload).digest("base64url");

    if (signature.length !== expected.length) {
      return null;
    }

    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return null;
    }

    let claims: { sub?: unknown; iat?: unknown; exp?: unknown };
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof claims;
    } catch {
      return null;
    }

    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") {
      return null;
    }

    if (claims.exp <= 0 || claims.exp * 1000 <= this.now()) {
      return null;
    }

    const rows = (await this.options.db.query(
      `SELECT state, valid_from FROM installations WHERE id = ?`,
      [claims.sub]
    )) as unknown as Array<{ state: string; valid_from: string | null }>;
    const installation = rows[0];

    if (installation?.state !== "active") {
      return null;
    }

    // A token minted before the last enrollment/rotation is dead even if it has
    // not expired yet: that is what makes re-enrollment after a revocation safe.
    if (installation.valid_from && claims.exp !== undefined) {
      const issuedAtMs = typeof claims.iat === "number" ? claims.iat * 1000 : 0;
      if (issuedAtMs < Date.parse(installation.valid_from)) {
        return null;
      }
    }

    return claims.sub as string;
  }

  async revokeInstallation(installationId: string, reason: string): Promise<boolean> {
    const now = this.now();
    const result = await this.options.db.execute(
      `UPDATE installations SET state = 'revoked', revoked_at = ? WHERE id = ? AND state = 'active'`,
      [new Date(now).toISOString(), installationId]
    );

    if (result.changes === 0) {
      return false;
    }

    await this.options.db.execute(
      `UPDATE installation_credentials SET revoked_at = ? WHERE installation_id = ? AND revoked_at IS NULL`,
      [new Date(now).toISOString(), installationId]
    );
    await this.audit("admin", null, "installation_revoked", installationId);
    void reason;

    return true;
  }

  async listInstallations(limit: number) {
    const rows = (await this.options.db.query(
      `SELECT id, install_id, state, app_version, platform, created_at, last_seen_at, revoked_at
         FROM installations ORDER BY last_seen_at DESC LIMIT ?`,
      [limit]
    )) as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      installId: String(row.install_id),
      state: String(row.state),
      appVersion: row.app_version === null ? null : String(row.app_version),
      platform: row.platform === null ? null : String(row.platform),
      createdAt: String(row.created_at),
      lastSeenAt: String(row.last_seen_at),
      revokedAt: row.revoked_at === null ? null : String(row.revoked_at)
    }));
  }

  private async createInstallation(
    input: {
      installId: string;
      appVersion?: string | null | undefined;
      platform?: string | null | undefined;
    },
    now: number
  ): Promise<IssuedCredentials> {
    const installationId = randomUUID();
    const timestamp = new Date(now).toISOString();

    await this.options.db.execute(
      `INSERT INTO installations
        (id, install_id, state, app_version, platform, created_at, last_seen_at, revoked_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?, NULL)`,
      [installationId, input.installId, input.appVersion ?? null, input.platform ?? null, timestamp, timestamp]
    );
    await this.audit("installation", installationId, "installation_enrolled", input.installId);

    return this.issuePair(installationId, randomUUID(), now);
  }

  private async issuePair(
    installationId: string,
    familyId: string,
    now: number
  ): Promise<IssuedCredentials> {
    const accessExpiresAt = new Date(now + this.options.accessTtlMs).toISOString();
    const refreshExpiresAt = new Date(now + this.options.refreshTtlMs).toISOString();
    const payload = base64url(
      JSON.stringify({
        sub: installationId,
        jti: randomUUID(),
        iat: Math.floor(now / 1000),
        exp: Math.floor((now + this.options.accessTtlMs) / 1000)
      })
    );
    const signature = createHmac("sha256", this.options.secret).update(payload).digest("base64url");
    const refreshToken = `maia_rt_${base64url(randomBytes(32))}`;

    await this.options.db.execute(
      `INSERT INTO installation_credentials
        (id, installation_id, family_id, token_hash, issued_at, expires_at, used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
      [
        randomUUID(),
        installationId,
        familyId,
        sha256(refreshToken),
        new Date(now).toISOString(),
        refreshExpiresAt
      ]
    );

    // Everything issued earlier stops verifying, regardless of its own expiry.
    await this.options.db.execute(`UPDATE installations SET valid_from = ? WHERE id = ?`, [
      new Date(Math.floor(now / 1000) * 1000).toISOString(),
      installationId
    ]);

    return {
      installationId,
      accessToken: `maia1.${payload}.${signature}`,
      accessExpiresAt,
      refreshToken,
      refreshExpiresAt
    };
  }

  private async revokeFamily(familyId: string, reason: string, now: number): Promise<void> {
    await this.options.db.execute(
      `UPDATE installation_credentials SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`,
      [new Date(now).toISOString(), familyId]
    );
    void reason;
  }

  private async audit(
    actorKind: string,
    actorId: string | null,
    action: string,
    target: string | null
  ): Promise<void> {
    await this.options.db.execute(
      `INSERT INTO audit_entries (occurred_at, actor_kind, actor_id, action, target, detail_json)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [new Date(this.now()).toISOString(), actorKind, actorId, action, target]
    );
  }
}

export interface AdminSession {
  sessionToken: string;
  adminId: string;
  email: string;
  expiresAt: string;
}

/** Backoffice operator sign-in, with expiring sessions. */
export class AdminAuthService {
  private readonly now: () => number;

  constructor(
    private readonly options: {
      db: SqlDatabase;
      sessionTtlMs: number;
      now?: () => number;
    }
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Admits somebody the product has already verified.
   *
   * There are no portal passwords any more: the identity is the product account
   * the shared email-code flow authenticated, and its `operator` capability is
   * re-checked on every request by the route guard. The `admin_users` row exists
   * so `admin_sessions` keeps a real foreign key; its id is the account id, and
   * its password digest is unusable by construction.
   */
  async signInVerified(accountId: string, email: string): Promise<AdminSession> {
    const normalized = email.trim().toLowerCase();
    const existing = (await this.options.db.query(`SELECT id FROM admin_users WHERE email = ?`, [
      normalized
    ])) as unknown as Array<{ id: string }>;

    // An installation upgraded from the password era may still hold a row for this
    // address under a different id; reuse it rather than violating uniqueness.
    const adminId = existing[0]?.id ?? accountId;
    if (!existing[0]) {
      await this.options.db.execute(
        `INSERT INTO admin_users (id, email, password_hash, role, created_at, disabled)
         VALUES (?, ?, '', 'operator', ?, 0)`,
        [accountId, normalized, new Date(this.now()).toISOString()]
      );
    }

    const sessionToken = `maia_as_${base64url(randomBytes(32))}`;
    const now = this.now();
    const expiresAt = new Date(now + this.options.sessionTtlMs).toISOString();

    await this.options.db.execute(
      `INSERT INTO admin_sessions (id, admin_id, created_at, expires_at, last_seen_at, ended_at, end_reason)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      [sha256(sessionToken), adminId, new Date(now).toISOString(), expiresAt, new Date(now).toISOString()]
    );
    await this.audit(adminId, "operator_signed_in", normalized);

    return { sessionToken, adminId, email: normalized, expiresAt };
  }

  async sessionFor(sessionToken: string): Promise<{ adminId: string; email: string } | null> {
    const rows = (await this.options.db.query(
      `SELECT s.id, s.admin_id, s.expires_at, s.ended_at, u.email, u.disabled
         FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_id
        WHERE s.id = ?`,
      [sha256(sessionToken)]
    )) as unknown as Array<{
      admin_id: string;
      expires_at: string;
      ended_at: string | null;
      email: string;
      disabled: number;
    }>;
    const session = rows[0];

    if (!session || session.ended_at !== null || session.disabled === 1) {
      return null;
    }

    if (Date.parse(session.expires_at) <= this.now()) {
      return null;
    }

    await this.options.db.execute(`UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?`, [
      new Date(this.now()).toISOString(),
      sha256(sessionToken)
    ]);

    return { adminId: session.admin_id, email: session.email };
  }

  async signOut(sessionToken: string): Promise<void> {
    await this.options.db.execute(
      `UPDATE admin_sessions SET ended_at = ?, end_reason = 'sign_out' WHERE id = ? AND ended_at IS NULL`,
      [new Date(this.now()).toISOString(), sha256(sessionToken)]
    );
  }

  private async audit(adminId: string | null, action: string, target: string | null): Promise<void> {
    await this.options.db.execute(
      `INSERT INTO audit_entries (occurred_at, actor_kind, actor_id, action, target, detail_json)
       VALUES (?, 'admin', ?, ?, ?, NULL)`,
      [new Date(this.now()).toISOString(), adminId, action, target]
    );
  }
}
