import re
from pathlib import Path

path = Path("apps/portal/src/services/portal-auth.ts")
src = path.read_text()

# 1. Repair the mangled region left by a bad edit: the class declaration and
# constructor were swallowed into an inserted method, and a newline was lost.
a = src.index("/** Backoffice administrator sign-in with hashed, expiring sessions. */  /**")
b = src.index(
    "  async signIn(email: string, password: string): Promise<AdminSession | null> {    const rows"
)

prefix = '''/** Backoffice operator sign-in, with expiring sessions. */
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

'''

src = src[:a] + prefix + src[b:]

# 2. Retire the password sign-in: no route reads a password any more.
start = src.index("  async signIn(email: string, password: string): Promise<AdminSession | null> {")
end = src.index("  async sessionFor(sessionToken: string)")
src = src[:start] + src[end:]

# 3. Retire the password hashing helpers, which nothing calls.
start = src.index("/** `scrypt$<salt>$<hash>`")
end = src.index("export interface AdminSession {")
src = src[:start] + src[end:]

# 4. Drop the now-unused scrypt import.
src = src.replace(
    'import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";',
    'import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";',
)

# 5. Tidy any triple blank lines the deletions left behind.
src = re.sub(r"\n{3,}", "\n\n", src)

path.write_text(src)
print("rewrote", path, len(src.splitlines()), "lines")
