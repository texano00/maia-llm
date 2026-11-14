import { loadConfig, type ServerConfig } from "./config.js";
import type { SqlDatabase } from "./db/database.js";
import { importLegacyReputation } from "./db/legacy-import.js";
import { migrate } from "./db/migrate.js";
import { migrations } from "./db/migrations/index.js";
import { openSqliteDatabase } from "./db/sqlite.js";
import {
  createGpuReputationRepository,
  type GpuReputationRepository,
} from "./repositories/gpu-reputation.js";
import { createFailureRepository, type FailureRepository } from "./repositories/failures.js";
import { createTelemetryRepository, type TelemetryRepository } from "./repositories/telemetry.js";
import { createUsageRepository, type UsageRepository } from "./repositories/usage.js";
import { FailureService } from "./services/failure-service.js";
import { GpuReputationService } from "./services/gpu-reputation-service.js";
import { TelemetryService } from "./services/telemetry-service.js";
import { UsageService } from "./services/usage-service.js";
import { AdminAuthService, TokenService } from "./services/portal-auth.js";
import { InternalClient } from "./services/internal-client.js";
import { createHuggingFaceCatalogueClient } from "./services/catalogue/huggingface.js";
import { SnapshotService } from "./services/catalogue/snapshot-service.js";
import { createUseCaseReader, type UseCaseSummary } from "./services/catalogue/use-cases.js";
import { UseCaseAdminService } from "./services/catalogue/use-case-admin.js";

export interface AppContext {
  config: ServerConfig;
  db: SqlDatabase;
  gpus: GpuReputationService;
  telemetry: TelemetryService;
  usage: UsageService;
  failures: FailureService;
  tokens: TokenService;
  admins: AdminAuthService;
  /** The product's internal API, read by the accounts view. */
  internal: InternalClient;
  snapshot: SnapshotService;
  useCases: () => Promise<UseCaseSummary[]>;
  useCaseAdmin: UseCaseAdminService;
  repositories: {
    gpus: GpuReputationRepository;
    telemetry: TelemetryRepository;
    failures: FailureRepository;
    usage: UsageRepository;
  };
  close(): Promise<void>;
}

export interface CreateAppContextOptions {
  config?: ServerConfig;
  /** Injected database (tests); the context will not close it. */
  db?: SqlDatabase;
  now?: () => number;
}

/**
 * Composition root.
 *
 * Wiring lives here and nowhere else: the server, the routes and the services
 * receive ready-made objects, so tests can swap the database, the clock or the
 * whole config without patching modules.
 */
export async function createAppContext(options: CreateAppContextOptions = {}): Promise<AppContext> {
  const config = options.config ?? loadConfig();
  const ownsDatabase = options.db === undefined;
  const db = options.db ?? openSqliteDatabase({ file: config.databaseFile });

  await migrate(db, migrations);

  const gpuRepository = createGpuReputationRepository(db);
  const telemetryRepository = createTelemetryRepository(db);
  const failureRepository = createFailureRepository(db);
  const usageRepository = createUsageRepository(db);

  if (config.legacyReputationFile) {
    await importLegacyReputation(gpuRepository, { file: config.legacyReputationFile });
  }

  const gpus = new GpuReputationService({
    repository: gpuRepository,
    unstableTtlMs: config.unstableTtlMs,
    ...(options.now ? { now: options.now } : {}),
  });

  const telemetry = new TelemetryService({
    repository: telemetryRepository,
    retentionMs: config.telemetryRetentionMs,
    ...(options.now ? { now: options.now } : {}),
  });

  const failures = new FailureService({
    repository: failureRepository,
    ...(options.now ? { now: options.now } : {}),
  });

  const usage = new UsageService(
    usageRepository,
    options.now ? () => new Date(options.now!()) : () => new Date(),
  );

  const tokens = new TokenService({    db,
    secret: config.portalTokenSecret,
    accessTtlMs: config.accessTokenTtlMs,
    refreshTtlMs: config.refreshTokenTtlMs,
    ...(options.now ? { now: options.now } : {}),
  });

  const admins = new AdminAuthService({
    db,
    sessionTtlMs: config.adminSessionTtlMs,
    ...(options.now ? { now: options.now } : {}),
  });

  // Bootstrap the single administrator from deployment configuration; the
  // backoffice has no self-service sign-up.
  if (config.adminEmail && config.adminPassword) {
    await admins.seed(config.adminEmail, config.adminPassword);
  }

  // Accounts and capabilities live in the product; the backoffice reads them with
  // a service token rather than with a person's identity.
  const internal = new InternalClient({
    baseUrl: config.webInternalUrl,
    token: config.internalToken,
  });

  const snapshot = new SnapshotService({
    db,
    client: createHuggingFaceCatalogueClient({ token: config.hfToken }),
    limit: config.catalogueLimit,
    ...(options.now ? { now: options.now } : {}),
  });
  const useCases = createUseCaseReader(db);
  const useCaseAdmin = new UseCaseAdminService({
    db,
    currentModels: async () => {
      const current = await snapshot.current();
      return new Map((current?.models ?? []).map((model) => [model.id, model]));
    },
    ...(options.now ? { now: options.now } : {}),
  });

  return {
    config,
    db,
    gpus,
    telemetry,
    failures,
    usage,
    tokens,
    admins,
    internal,
    snapshot,
    useCases,
    useCaseAdmin,
    repositories: { gpus: gpuRepository, telemetry: telemetryRepository, failures: failureRepository, usage: usageRepository },
    async close() {
      if (ownsDatabase) {
        await db.close();
      }
    },
  };
}
