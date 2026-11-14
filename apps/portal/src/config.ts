import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SqlDialect } from "./db/database.js";

export interface ServerConfig {
  /** This portal build's version, read from its own manifest. */
  version: string;
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
  /** Product base URL for the internal accounts API (`http://maia-web:5173`). */
  webInternalUrl: string;
  /**
   * Shared secret for the product's `/internal/*` API, used by the accounts view.
   * Unset means that view reports the product as unreachable; the rest of the
   * backoffice keeps working.
   */
  internalToken: string | null;
  /**
   * Enforce installation credentials on ingestion routes. Off by default so a
   * client that never enrolled still reaches its diagnostics.
   */
  requireClientAuth: boolean;
  /** Bootstrap administrator, seeded on first boot when both are set. */
  adminEmail: string | null;
  adminPassword: string | null;
  /** Service credential used to build the catalogue snapshot. */
  hfToken: string | null;
  /** How often the snapshot is rebuilt. */
  catalogueRefreshHours: number;
  /** How many models one snapshot pass covers. */
  catalogueLimit: number;
  /**
   * Repositories that are always included, whatever their download rank.
   * Popularity alone hides the community finetunes people actually look for.
   */
  catalogueRequired: string[];
  /** Accept opt-in usage measurements at `/api/v0/usage`. */
  usageEnabled: boolean;
}

/**
 * The portal's own release version.
 *
 * `MAIA_APP_VERSION` wins so a container can be told what it is; otherwise the
 * bundled manifest is read, the same way the product resolves its version. A
 * container built from a tagged commit therefore reports that tag rather than
 * whatever was in the file when the image was cached.
 */
export function portalVersion(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MAIA_APP_VERSION?.trim();
  if (explicit) {
    return explicit;
  }

  for (const relative of ["../package.json", "../../package.json"]) {
    try {
      const manifest = JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as {
        version?: unknown;
      };
      if (typeof manifest.version === "string" && manifest.version.length > 0) {
        return manifest.version;
      }
    } catch {
      // Built bundle without a manifest beside it; try the next candidate.
    }
  }

  return "unknown";
}

const DRIVERS: readonly SqlDialect[] = ["sqlite", "postgres", "mysql"];

/**
 * Models people ask for by name.
 *
 * The ranked listing is a popularity contest, so a specialist or brand-new
 * finetune is invisible until it is already popular — which is backwards for a
 * catalogue whose job is to list what exists. These are always included, and
 * `MAIA_CATALOGUE_REQUIRED` adds to them without a rebuild.
 */
export const DEFAULT_REQUIRED_REPOSITORIES: readonly string[] = [
  // Community abliterated models, asked for by name; far outside the top 300.
  "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF",
  "huihui-ai/DeepSeek-R1-Distill-Qwen-32B-abliterated"
];

/**
 * `owner/name` entries, comma separated. Anything without a slash is dropped:
 * a malformed entry would otherwise be requested from the Hub forever.
 */
export function parseRepositoryList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim();
    const segments = id.split("/");
    if (segments.length === 2 && segments.every((segment) => segment.length > 0)) {
      seen.add(id);
    }
  }

  return [...seen];
}

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
    version: portalVersion(env),
    databaseDriver: driver,
    databaseFile: env.MAIA_DATABASE_FILE ?? resolve(process.cwd(), "var/maia.sqlite"),
    unstableTtlMs: positive(env.MAIA_UNSTABLE_TTL_HOURS, 6) * 60 * 60_000,
    telemetryRetentionMs: positive(env.MAIA_TELEMETRY_RETENTION_DAYS, 30) * 24 * 60 * 60_000,
    legacyReputationFile: env.MAIA_REPUTATION_FILE ?? null,
    portalTokenSecret: env.MAIA_PORTAL_TOKEN_SECRET ?? "dev-only-token-secret",
    accessTokenTtlMs: positive(env.MAIA_PORTAL_ACCESS_TTL_MINUTES, 60) * 60_000,
    refreshTokenTtlMs: positive(env.MAIA_PORTAL_REFRESH_TTL_DAYS, 30) * 24 * 60 * 60_000,
    adminSessionTtlMs: positive(env.MAIA_ADMIN_SESSION_HOURS, 12) * 60 * 60_000,
    webInternalUrl: env.MAIA_WEB_INTERNAL_URL ?? "http://maia-web:5173",
    internalToken: env.MAIA_INTERNAL_TOKEN?.trim() || null,
    requireClientAuth: env.MAIA_REQUIRE_CLIENT_AUTH === "true",
    adminEmail: env.MAIA_ADMIN_EMAIL ?? null,
    adminPassword: env.MAIA_ADMIN_PASSWORD ?? null,
    hfToken: env.MAIA_PORTAL_HF_TOKEN ?? env.HF_TOKEN ?? null,
    catalogueRefreshHours: positive(env.MAIA_CATALOGUE_REFRESH_HOURS, 6),
    catalogueLimit: positive(env.MAIA_CATALOGUE_LIMIT, 300),
    catalogueRequired: [
      ...new Set([...DEFAULT_REQUIRED_REPOSITORIES, ...parseRepositoryList(env.MAIA_CATALOGUE_REQUIRED)])
    ],
    usageEnabled: env.MAIA_USAGE_ENABLED !== "false",
  };
}

/** Defaults with explicit overrides — used by tests and by `buildServer`. */
export function baseConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { ...loadConfig(), ...overrides };
}
