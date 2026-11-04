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
import { createTelemetryRepository, type TelemetryRepository } from "./repositories/telemetry.js";
import { GpuReputationService } from "./services/gpu-reputation-service.js";
import { TelemetryService } from "./services/telemetry-service.js";

export interface AppContext {
  config: ServerConfig;
  db: SqlDatabase;
  gpus: GpuReputationService;
  telemetry: TelemetryService;
  repositories: {
    gpus: GpuReputationRepository;
    telemetry: TelemetryRepository;
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

  return {
    config,
    db,
    gpus,
    telemetry,
    repositories: { gpus: gpuRepository, telemetry: telemetryRepository },
    async close() {
      if (ownsDatabase) {
        await db.close();
      }
    },
  };
}
