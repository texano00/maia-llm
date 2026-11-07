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
import { FailureService } from "./services/failure-service.js";
import { GpuReputationService } from "./services/gpu-reputation-service.js";
import { TelemetryService } from "./services/telemetry-service.js";
import { AdminAuthService, TokenService } from "./services/portal-auth.js";
import { createHuggingFaceCatalogueClient } from "./services/catalogue/huggingface.js";
import { SnapshotService } from "./services/catalogue/snapshot-service.js";
import { createUseCaseReader, type UseCaseSummary } from "./services/catalogue/use-cases.js";

export interface AppContext {
  config: ServerConfig;
  db: SqlDatabase;
  gpus: GpuReputationService;
  telemetry: TelemetryService;
  failures: FailureService;
  tokens: TokenService;
  admins: AdminAuthService;
  snapshot: SnapshotService;
  useCases: () => Promise<UseCaseSummary[]>;
  repositories: {
    gpus: GpuReputationRepository;
    telemetry: TelemetryRepository;
    failures: FailureRepository;
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

  const tokens = new TokenService({
    db,
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

  const snapshot = new SnapshotService({
    db,
    client: createHuggingFaceCatalogueClient({ token: config.hfToken }),
    limit: config.catalogueLimit,
    ...(options.now ? { now: options.now } : {}),
  });
  const useCases = createUseCaseReader(db);

  return {
    config,
    db,
    gpus,
    telemetry,
    failures,
    tokens,
    admins,
    snapshot,
    useCases,
    repositories: { gpus: gpuRepository, telemetry: telemetryRepository, failures: failureRepository },
    async close() {
      if (ownsDatabase) {
        await db.close();
      }
    },
  };
}
