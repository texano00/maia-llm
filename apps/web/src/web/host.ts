import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IpcChannel } from "@maia/contracts";
import { closeDatabase, createConnection, type DatabaseConnection } from "../main/storage/connection";
import { loadMigrations } from "./migrations";
import { AccountRepository } from "../main/services/accounts/repository";
import { AccessService } from "../main/services/accounts/service";
import { parseOperatorEmails } from "../main/services/accounts/capabilities";
import { SettingsStore } from "../main/services/settings/store";
import { createMailer } from "../main/services/accounts/mailer";
import { createCaptchaVerifier } from "../main/services/accounts/turnstile";
import { loadCredentialKey } from "../main/services/credentials/vault";
import { CatalogueRepository } from "../main/services/catalogue/repository";
import { CatalogueService } from "../main/services/catalogue/service";
import { createFixtureCatalogueSource } from "../main/services/catalogue/fixture-source";
import { createHuggingFaceSource } from "../main/services/catalogue/huggingface-source";
import { GpuReputationClient } from "../main/services/gpu/reputation";
import type { IpcRegistry } from "../main/ipc/registry";
import { createAccountRuntime, type AccountRuntime, type WebLogger } from "./accounts";
import { createPublicRegistry } from "./public";

export interface WebPlatformOptions {
  databasePath: string;
  providerMode: "live" | "mock";
  readinessTimeoutMinutes?: number;
  idleTimeoutMinutes?: number;
  /** Shared event sink; the account id is part of every record. */
  onEvent?: ((accountId: string, channel: string, payload: unknown) => void) | undefined;
  logger?: WebLogger;
  env?: Record<string, string | undefined>;
}

export interface WebPlatform {
  database: DatabaseConnection;
  catalogue: CatalogueService;
  access: AccessService;
  /** Channels callable without a session: `app.info` and the access flow. */
  publicRegistry: IpcRegistry;
  accounts: AccountRuntimes;
  dispose(): Promise<void>;
}

/** Channels that must work before a session exists. */
export const publicChannels = new Set<IpcChannel>([
  "app.info",
  "auth.config",
  "auth.state",
  "auth.requestCode",
  "auth.verifyCode",
  "auth.signOut"
]);

/**
 * Keeps one service graph per account in memory.
 *
 * The graph owns the session orchestrator, so it must outlive a single request
 * (a chat turn streams across many). An evicted graph is suspended, not torn
 * down: sessions stay in SQLite and the next request rehydrates them.
 */
export class AccountRuntimes {
  private readonly entries = new Map<string, { runtime: AccountRuntime; lastUsedAt: number }>();

  constructor(
    private readonly factory: (accountId: string) => Promise<AccountRuntime>,
    private readonly now: () => number = () => Date.now()
  ) {}

  async get(accountId: string): Promise<AccountRuntime> {
    const existing = this.entries.get(accountId);
    if (existing) {
      existing.lastUsedAt = this.now();
      return existing.runtime;
    }

    const runtime = await this.factory(accountId);
    this.entries.set(accountId, { runtime, lastUsedAt: this.now() });
    return runtime;
  }

  evict(accountId: string): void {
    const entry = this.entries.get(accountId);
    if (!entry) {
      return;
    }

    entry.runtime.suspend();
    this.entries.delete(accountId);
  }

  /** Suspends graphs idle for longer than `idleMs`; returns how many. */
  sweep(idleMs: number): number {
    const now = this.now();
    let evicted = 0;

    for (const [accountId, entry] of this.entries) {
      if (now - entry.lastUsedAt < idleMs) {
        continue;
      }

      entry.runtime.suspend();
      this.entries.delete(accountId);
      evicted += 1;
    }

    return evicted;
  }

  async disposeAll(): Promise<void> {
    for (const [, entry] of this.entries) {
      await entry.runtime.endSessions("app_exit");
    }

    this.entries.clear();
  }
}

/**
 * The shared platform: the database, the public catalogue and the access flow.
 * Account data is never reached from here — that is what `AccountRuntimes`
 * builds on demand.
 */
export async function createWebPlatform(options: WebPlatformOptions): Promise<WebPlatform> {
  const env = options.env ?? process.env;
  const logger: WebLogger = options.logger ?? {
    info: (message: string) => console.log(`[web] ${message}`),
    warn: (message: string) => console.warn(`[web] ${message}`),
    error: (message: string) => console.error(`[web] ${message}`)
  };

  const database = createConnection(options.databasePath, loadMigrations());
  const accountsRepository = new AccountRepository(database);

  const access = new AccessService({
    repository: accountsRepository,
    mailer: createMailer({ env, logger }),
    captcha: createCaptchaVerifier({ env, logger }),
    sessionSecret: resolveSessionSecret(env, logger),
    // Read on `auth.state` only, so the cookie can carry the account's choice
    // to the next first paint.
    appearanceFor: (accountId) => new SettingsStore(database, accountId).get().appearance,
    // Accounts named here are operators from birth: a fresh deployment needs
    // somebody who can grant the others.
    operatorEmails: parseOperatorEmails(env.MAIA_OPERATOR_EMAILS)
  });

  // Accounts that predate the capability column keep their identity and gain the
  // grant now, so nobody is locked out of the portal after an upgrade.
  access.bootstrapOperators();

  const catalogueRepository = new CatalogueRepository(database);
  const catalogue = new CatalogueService({
    repository: catalogueRepository,
    source:
      options.providerMode === "live"
        ? // The catalogue is public data: it reads with the deployment token, not
          // with anybody's personal provider key.
          createHuggingFaceSource({
            getToken: async () => env.MAIA_PORTAL_HF_TOKEN ?? env.HF_TOKEN
          })
        : createFixtureCatalogueSource(),
    logger,
    ...(options.providerMode === "mock" ? { ttlMs: 0 } : {})
  });

  const reputation = new GpuReputationClient({
    getBaseUrl: () => env.MAIA_REPUTATION_URL ?? "https://api.maiallm.com",
    logger
  });

  const { key: credentialKey } = loadCredentialKey({ env, logger });
  const imagesDir = join(dirname(options.databasePath), "images");

  const accounts = new AccountRuntimes((accountId) =>
    createAccountRuntime({
      accountId,
      database,
      imagesDir,
      catalogue,
      catalogueRepository,
      reputation,
      providerMode: options.providerMode,
      credentialKey,
      access,
      ...(options.readinessTimeoutMinutes !== undefined
        ? { readinessTimeoutMinutes: options.readinessTimeoutMinutes }
        : {}),
      ...(options.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: options.idleTimeoutMinutes }
        : {}),
      logger,
      onEvent: (id, channel, payload) => options.onEvent?.(id, channel, payload)
    })
  );

  // Only at process start: sessions left in the database belong to a previous
  // process, and their keys are gone, so the first run of each account releases
  // the GPU before anyone can send a message to it.
  const orphans = database
    .prepare(
      `SELECT DISTINCT account_id FROM sessions
        WHERE account_id IS NOT NULL
          AND state IN ('estimated', 'provisioning', 'ready', 'active', 'ending')`
    )
    .all() as Array<{ account_id: string }>;

  for (const row of orphans) {
    const runtime = await accounts.get(row.account_id);
    const released = await runtime.orchestrator.reconcile();
    if (released > 0) {
      logger.warn(`released ${released} session(s) left behind by a previous run`);
    }
  }

  const publicRegistry = createPublicRegistry(access, {
    version: resolveVersion(env),
    providerMode: options.providerMode
  });

  const sweepTimer = setInterval(() => accounts.sweep(30 * 60_000), 60_000);
  sweepTimer.unref?.();
  const pruneTimer = setInterval(() => access.prune(), 10 * 60_000);
  pruneTimer.unref?.();

  return {
    database,
    catalogue,
    access,
    publicRegistry,
    accounts,
    async dispose() {
      clearInterval(sweepTimer);
      clearInterval(pruneTimer);
      await accounts.disposeAll();
      closeDatabase(database);
    }
  };
}

/**
 * Release version for the build-info panel: the deployment override first, then
 * the package manifest beside the running bundle (source tree or container).
 * "unknown" is a real answer the panel states in words, not a placeholder.
 */
function resolveVersion(env: Record<string, string | undefined>): string {
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
      // Try the next location.
    }
  }

  return "unknown";
}

function resolveSessionSecret(
  env: Record<string, string | undefined>,
  logger: WebLogger
): string {  const secret = env.MAIA_SESSION_SECRET?.trim();
  if (secret) {
    return secret;
  }

  if (env.NODE_ENV === "production") {
    throw new Error(
      "MAIA_SESSION_SECRET is required in production: access codes are keyed with it. " +
        "Generate one with: openssl rand -base64 48"
    );
  }

  logger.warn(
    "MAIA_SESSION_SECRET is not set: using an ephemeral secret, existing sessions and codes stop working on restart"
  );
  return randomBytes(32).toString("hex");
}
