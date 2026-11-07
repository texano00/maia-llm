import { resolve } from "node:path";
import type { SqlDialect } from "./db/database.js";

export interface ServerConfig {
  /** Storage engine. Only `sqlite` ships today; the port is dialect-neutral. */
  databaseDriver: SqlDialect;
  /** SQLite file; `:memory:` is accepted for tests. */
  databaseFile: string;
  /** How long an `unstable` GPU verdict stays in force. */
  unstableTtlMs: number;
  /** How long ingested telemetry is retained. */
  telemetryRetentionMs: number;
  /** Pre-SQLite JSON file imported once on first boot, if present. */
  legacyReputationFile: string | null;
  /** HMAC key for installation access tokens; a deployment secret. */
  portalTokenSecret: string;
  /** Access-token lifetime; the spec caps it at 60 minutes. */
  accessTokenTtlMs: number;
  /** Refresh-token lifetime; the spec caps it at 30 days. */
  refreshTokenTtlMs: number;
  /** Backoffice session lifetime. */
  adminSessionTtlMs: number;
  /**
   * Enforce installation credentials on ingestion routes. Off until desktop
   * enrollment ships, so an older client does not lose its diagnostics.
   */
  requireClientAuth: boolean;
  /** Bootstrap administrator, seeded on first boot when both are set. */
  adminEmail: string | null;
  adminPassword: string | null;
}

const DRIVERS: readonly SqlDialect[] = ["sqlite", "postgres", "mysql"];

const positive = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * Reads the environment once, at boot. Everything downstream takes the config
 * object, which keeps environment lookups out of tests and out of request paths.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const driver = (env.MAIA_DB_DRIVER ?? "sqlite").toLowerCase() as SqlDialect;

  if (!DRIVERS.includes(driver)) {
    throw new Error(
      `Unsupported MAIA_DB_DRIVER "${driver}". Supported values: ${DRIVERS.join(", ")}.`,
    );
  }

  if (driver !== "sqlite") {
    throw new Error(
      `MAIA_DB_DRIVER="${driver}" is not implemented yet: add an adapter in src/db/ that implements ` +
        `SqlDatabase, then select it here. Repositories and migrations need no changes.`,
    );
  }

  return {
    databaseDriver: driver,
    databaseFile: env.MAIA_DATABASE_FILE ?? resolve(process.cwd(), "var/maia.sqlite"),
    unstableTtlMs: positive(env.MAIA_UNSTABLE_TTL_HOURS, 6) * 60 * 60_000,
    telemetryRetentionMs: positive(env.MAIA_TELEMETRY_RETENTION_DAYS, 30) * 24 * 60 * 60_000,
    legacyReputationFile: env.MAIA_REPUTATION_FILE ?? null,
    portalTokenSecret: env.MAIA_PORTAL_TOKEN_SECRET ?? "dev-only-token-secret",
    accessTokenTtlMs: positive(env.MAIA_PORTAL_ACCESS_TTL_MINUTES, 60) * 60_000,
    refreshTokenTtlMs: positive(env.MAIA_PORTAL_REFRESH_TTL_DAYS, 30) * 24 * 60 * 60_000,
    adminSessionTtlMs: positive(env.MAIA_ADMIN_SESSION_HOURS, 12) * 60 * 60_000,
    requireClientAuth: env.MAIA_REQUIRE_CLIENT_AUTH === "true",
    adminEmail: env.MAIA_ADMIN_EMAIL ?? null,
    adminPassword: env.MAIA_ADMIN_PASSWORD ?? null,
  };
}

/** Defaults with explicit overrides — used by tests and by `buildServer`. */
export function baseConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { ...loadConfig(), ...overrides };
}
