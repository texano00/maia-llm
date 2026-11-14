import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../src/db/migrate.js";
import { migrations } from "../../src/db/migrations/index.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/db/sqlite.js";
import {
  AdminAuthService,
  TokenService
} from "../../src/services/portal-auth.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe("installation credentials", () => {
  let directory: string;
  let db: SqliteDatabase;
  let clock: number;
  let tokens: TokenService;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "maia-portal-auth-"));
    db = openSqliteDatabase({ file: join(directory, "maia.sqlite") });
    await migrate(db, migrations);
    clock = Date.parse("2026-11-07T10:00:00.000Z");
    tokens = new TokenService({
      db,
      secret: "test-secret",
      accessTtlMs: HOUR,
      refreshTtlMs: 30 * DAY,
      now: () => clock
    });
  });

  afterEach(async () => {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("enrolls an installation and verifies its access token without a lookup per request", async () => {
    const issued = await tokens.enroll({ installId: "install-abcdefgh", appVersion: "0.8.0", platform: "win32" });

    expect(issued.accessToken.startsWith("maia1.")).toBe(true);
    expect(issued.refreshToken.startsWith("maia_rt_")).toBe(true);
    await expect(tokens.verifyAccess(issued.accessToken)).resolves.toBe(issued.installationId);

    // Re-enrolling the same installation keeps its identity.
    const again = await tokens.enroll({ installId: "install-abcdefgh" });
    expect(again.installationId).toBe(issued.installationId);
  });

  it("rejects a tampered or expired access token", async () => {
    const issued = await tokens.enroll({ installId: "install-tamper" });

    const [prefix, payload, signature] = issued.accessToken.split(".");
    await expect(tokens.verifyAccess(`${prefix}.${payload}.${signature}x`)).resolves.toBeNull();

    clock += HOUR + 1;
    await expect(tokens.verifyAccess(issued.accessToken)).resolves.toBeNull();
  });

  it("rotates the refresh token and burns the family when one is replayed", async () => {
    const issued = await tokens.enroll({ installId: "install-rotate" });
    clock += 60_000;

    const rotated = await tokens.refresh(issued.refreshToken);
    expect(rotated).not.toBeNull();
    expect(rotated?.refreshToken).not.toBe(issued.refreshToken);

    // The old token is now used: presenting it again is treated as theft.
    await expect(tokens.refresh(issued.refreshToken)).resolves.toBeNull();
    // …and the whole family is gone, including the freshly rotated one.
    await expect(tokens.refresh(rotated!.refreshToken)).resolves.toBeNull();
  });

  it("re-enrolling a revoked installation starts a new credential epoch", async () => {
    const issued = await tokens.enroll({ installId: "install-revoked" });

    await expect(tokens.revokeInstallation(issued.installationId, "admin")).resolves.toBe(true);
    await expect(tokens.verifyAccess(issued.accessToken)).resolves.toBeNull();
    await expect(tokens.refresh(issued.refreshToken)).resolves.toBeNull();

    clock += 2_000;
    const reenrolled = await tokens.enroll({ installId: "install-revoked" });

    // The old access token is still unexpired but belongs to the previous epoch.
    await expect(tokens.verifyAccess(issued.accessToken)).resolves.toBeNull();
    await expect(tokens.verifyAccess(reenrolled.accessToken)).resolves.toBe(reenrolled.installationId);
  });

  it("lists installations with their last contact time", async () => {
    await tokens.enroll({ installId: "install-list-a", appVersion: "0.8.0" });
    clock += 1_000;
    await tokens.enroll({ installId: "install-list-b", appVersion: "0.8.1" });

    const listed = await tokens.listInstallations(10);
    expect(listed).toHaveLength(2);
    expect(listed[0]?.appVersion).toBe("0.8.1");
    expect(listed[0]?.state).toBe("active");
  });
});

describe("operator sessions", () => {
  let directory: string;
  let db: SqliteDatabase;
  let clock: number;
  let admins: AdminAuthService;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "maia-portal-admin-"));
    db = openSqliteDatabase({ file: join(directory, "maia.sqlite") });
    await migrate(db, migrations);
    clock = Date.parse("2026-11-07T10:00:00.000Z");
    admins = new AdminAuthService({ db, sessionTtlMs: 12 * HOUR, now: () => clock });
  });

  afterEach(async () => {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keys the session by the product account that was verified", async () => {
    const session = await admins.signInVerified("account-1", "Operator@Maia.test");

    expect(session.adminId).toBe("account-1");
    expect(session.email).toBe("operator@maia.test");
    await expect(admins.sessionFor(session.sessionToken)).resolves.toMatchObject({
      adminId: "account-1",
      email: "operator@maia.test"
    });
  });

  it("admits the same operator twice without a duplicate row", async () => {
    await admins.signInVerified("account-1", "operator@maia.test");
    const second = await admins.signInVerified("account-1", "operator@maia.test");

    const rows = (await db.query("SELECT id FROM admin_users WHERE email = ?", [
      "operator@maia.test"
    ])) as unknown as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(second.adminId).toBe("account-1");
  });

  it("resolves a session, expires it and signs out", async () => {
    const session = await admins.signInVerified("account-1", "operator@maia.test");
    await expect(admins.sessionFor(session.sessionToken)).resolves.not.toBeNull();

    await admins.signOut(session.sessionToken);
    await expect(admins.sessionFor(session.sessionToken)).resolves.toBeNull();

    const second = await admins.signInVerified("account-1", "operator@maia.test");
    clock += 12 * HOUR + 1;
    await expect(admins.sessionFor(second.sessionToken)).resolves.toBeNull();
  });
});
