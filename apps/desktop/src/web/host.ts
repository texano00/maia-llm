import { z } from "zod";
import { chatEventChannel, type IpcChannel } from "@maia/contracts";
import { closeDatabase, createConnection, type DatabaseConnection } from "../main/storage/connection";
import { loadMigrations } from "./migrations";
import { HistoryRepository } from "../main/services/history/repository";
import { SettingsStore } from "../main/services/settings/store";
import { CatalogueRepository } from "../main/services/catalogue/repository";
import { CatalogueService } from "../main/services/catalogue/service";
import { createFixtureCatalogueSource } from "../main/services/catalogue/fixture-source";
import {
  createHuggingFaceSource,
  testHuggingFaceToken
} from "../main/services/catalogue/huggingface-source";
import { CredentialStore } from "../main/services/credentials/store";
import { SessionOrchestrator } from "../main/services/sessions/orchestrator";
import { SessionStore } from "../main/services/sessions/store";
import { createMockComputeProvider, createMockInference } from "../main/services/providers/mock-runtime";
import { createVastComputeProvider } from "../main/services/providers/vastai/compute-provider";
import { VastAiClient } from "../main/services/providers/vastai/client";
import { createVllmRuntime } from "../main/services/inference/vllm";
import { GpuReputationClient } from "../main/services/gpu/reputation";
import { IpcRegistry } from "../main/ipc/registry";
import { registerSettingsHandlers } from "../main/ipc/settings";
import { registerWorkspaceHandlers } from "../main/ipc/workspace";
import { EnvSecretVault } from "./vault";

export interface WebHostOptions {
  databasePath: string;
  providerMode: "live" | "mock";
  readinessTimeoutMinutes?: number;
  idleTimeoutMinutes?: number;
  onEvent?: ((channel: string, payload: unknown) => void) | undefined;
  logger?: {
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>): void;
  };
}

export interface WebHost {
  registry: IpcRegistry;
  invoke(channel: IpcChannel, payload: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}

/**
 * Runs the desktop services inside a plain Node process so the same renderer can
 * be exercised in a browser. Only the transport differs: channels are invoked
 * over HTTP and chat/update events are pushed over SSE.
 */
export async function createWebHost(options: WebHostOptions): Promise<WebHost> {
  const logger = options.logger ?? {
    info: (message: string) => console.log(`[web] ${message}`),
    warn: (message: string) => console.warn(`[web] ${message}`),
    error: (message: string) => console.error(`[web] ${message}`)
  };

  const database: DatabaseConnection = createConnection(options.databasePath, loadMigrations());
  const settings = new SettingsStore(database);
  const repository = new HistoryRepository(database);
  const credentials = new CredentialStore(database, new EnvSecretVault());

  // Keys from the environment (VAST_API_KEY, HF_TOKEN) go through the normal
  // store so `credentials.status()` and the connection tests see them.
  for (const [provider, secret] of [
    ["vastai", process.env.VAST_API_KEY],
    ["huggingface", process.env.HF_TOKEN]
  ] as const) {
    if (secret && !(await credentials.get(provider))) {
      await credentials.set(provider, secret);
    }
  }

  const catalogueRepository = new CatalogueRepository(database);
  const catalogue = new CatalogueService({
    repository: catalogueRepository,
    source:
      options.providerMode === "live"
        ? createHuggingFaceSource({ getToken: () => credentials.get("huggingface") })
        : createFixtureCatalogueSource(),
    logger,
    ...(options.providerMode === "mock" ? { ttlMs: 0 } : {})
  });

  const reputation = new GpuReputationClient({
    getBaseUrl: () => process.env.MAIA_REPUTATION_URL ?? settings.get().diagnosticsUrl,
    logger
  });

  const hasVastKey = Boolean(await credentials.get("vastai"));
  const useLiveGpu = options.providerMode === "live" && hasVastKey;

  const compute = useLiveGpu
    ? createVastComputeProvider({
        getApiKey: () => credentials.get("vastai"),
        getHfToken: () => credentials.get("huggingface"),
        getParameterCount: async (modelId) => catalogueRepository.get(modelId)?.parameterCount ?? null,
        getFilters: () => settings.get().gpuFilters,
        getReputations: () => reputation.snapshot(),
        reportOutcome: (input) => reputation.report(input),
        readyTimeoutMs: (options.readinessTimeoutMinutes ?? 20) * 60_000,
        logger
      })
    : createMockComputeProvider({ provisionDelayMs: 400 });

  const inference = useLiveGpu
    ? createVllmRuntime({
        resolveEndpoint: (instanceId) =>
          "resolveEndpoint" in compute ? compute.resolveEndpoint(instanceId) : null
      })
    : createMockInference({ chunkDelayMs: 12 });

  const sessions = new SessionOrchestrator({
    store: new SessionStore(database),
    compute,
    inference,
    idleTimeoutMinutes: options.idleTimeoutMinutes ?? 10,
    readinessTimeoutMs: (options.readinessTimeoutMinutes ?? 20) * 60_000,
    filters: () => settings.get().gpuFilters,
    logger
  });

  const reconciled = await sessions.reconcile();
  if (reconciled > 0) {
    logger.warn(`released ${reconciled} session(s) left behind by a previous run`);
  }

  const registry = new IpcRegistry({
    onError: (channel, error) => {
      logger.error(`channel ${channel} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  registry.register("app.info", z.unknown(), () => ({
    app: "web",
    electron: "n/a",
    chrome: "n/a",
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    channel: "stable" as const,
    packaged: false
  }));

  // The browser build has no updater; report idle so the UI keeps working.
  registry.register("update.status", z.unknown(), () => idleUpdateStatus());
  registry.register("update.check", z.unknown(), () => idleUpdateStatus());
  registry.register("update.download", z.unknown(), () => idleUpdateStatus());
  registry.register("update.install", z.unknown(), () => idleUpdateStatus());

  registerSettingsHandlers({
    registry,
    store: settings,
    credentials,
    testCredential: async (provider, secret) => {
      try {
        if (provider === "huggingface") {
          const ok = await testHuggingFaceToken(secret);
          return { ok, message: ok ? "Hugging Face accepted the token." : "Hugging Face rejected the token." };
        }

        if (provider === "vastai") {
          const ok = await new VastAiClient(secret).testConnection();
          return { ok, message: ok ? "vast.ai accepted the API key." : "vast.ai rejected the API key." };
        }

        return { ok: false, message: `${provider} connection tests are not wired yet.` };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : `${provider} request failed` };
      }
    }
  });

  registerWorkspaceHandlers({
    registry,
    catalogue,
    sessions,
    history: repository,
    broadcastChat: (payload) => options.onEvent?.(chatEventChannel, payload)
  });

  const idleTimer = setInterval(() => void sessions.reapIdle(), 30_000);
  idleTimer.unref?.();

  return {
    registry,
    async invoke(channel, payload) {
      const result = await registry.invoke(channel, payload);
      if (result.ok) {
        return result.data;
      }

      throw Object.assign(new Error(result.error.message), { code: result.error.code });
    },
    async dispose() {
      clearInterval(idleTimer);
      await sessions.endAll("app_exit");
      closeDatabase(database);
    }
  };
}

function idleUpdateStatus() {
  return {
    phase: "idle" as const,
    currentVersion: "web",
    channel: "stable" as const,
    message: "Updates are handled by the installed desktop app."
  };
}
