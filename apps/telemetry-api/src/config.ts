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
  };
}

/** Defaults with explicit overrides — used by tests and by `buildServer`. */
export function baseConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { ...loadConfig(), ...overrides };
}
