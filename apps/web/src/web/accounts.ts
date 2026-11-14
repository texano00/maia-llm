import { z } from "zod";
import { authDeleteAccountSchema, capabilityForPipelineTag, chatEventChannel } from "@maia/contracts";
import type { DatabaseConnection } from "../main/storage/db";
import { HistoryRepository } from "../main/services/history/repository";
import { ConversationImageStore } from "../main/services/history/images";
import { SettingsStore } from "../main/services/settings/store";
import type { CatalogueRepository } from "../main/services/catalogue/repository";
import type { CatalogueService } from "../main/services/catalogue/service";
import { assertChatRunnable } from "../main/services/catalogue/runnable";
import { testHuggingFaceToken } from "../main/services/catalogue/huggingface-source";
import { CredentialStore } from "../main/services/credentials/store";
import { EncryptedSecretVault } from "../main/services/credentials/vault";
import { SessionOrchestrator } from "../main/services/sessions/orchestrator";
import { SessionStore } from "../main/services/sessions/store";
import { createMockComputeProvider, createMockInference } from "../main/services/providers/mock-runtime";
import { createVastComputeProvider } from "../main/services/providers/vastai/compute-provider";
import { VastAiClient } from "../main/services/providers/vastai/client";
import { createVllmRuntime } from "../main/services/inference/vllm";
import { createModelPlanResolver } from "../main/services/inference/model-plan-resolver";
import { createFailureReporter } from "../main/services/diagnostics/failures";
import type { GpuReputationClient } from "../main/services/gpu/reputation";
import { IpcRegistry } from "../main/ipc/registry";
import { registerSettingsHandlers } from "../main/ipc/settings";
import { registerWorkspaceHandlers } from "../main/ipc/workspace";
import type { AccessService } from "../main/services/accounts/service";

export interface WebLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface AccountRuntimeOptions {
  accountId: string;
  database: DatabaseConnection;
  /** Root of the image tree; each runtime writes under `<imagesDir>/<accountId>`. */
  imagesDir: string;
  catalogue: CatalogueService;
  catalogueRepository: CatalogueRepository;
  reputation: GpuReputationClient;
  providerMode: "live" | "mock";
  /** 32-byte AES key for provider credentials. */
  credentialKey: Buffer;
  access: AccessService;
  readinessTimeoutMinutes?: number;
  idleTimeoutMinutes?: number;
  logger: WebLogger;
  onEvent: (accountId: string, channel: string, payload: unknown) => void;
}

export interface AccountRuntime {
  accountId: string;
  registry: IpcRegistry;
  orchestrator: SessionOrchestrator;
  images: ConversationImageStore;
  /** Stops timers only; running sessions survive a cache eviction. */
  suspend(): void;
  /** Releases remote GPUs; used when the account is deleted or the process exits. */
  endSessions(reason: "app_exit" | "user"): Promise<void>;
}

/**
 * One service graph per account.
 *
 * Every repository is constructed with the account id, so no handler can read
 * or write another account's rows by forgetting a predicate: the predicate is
 * part of the object it was given.
 */
export async function createAccountRuntime(
  options: AccountRuntimeOptions
): Promise<AccountRuntime> {
  const { accountId, database, logger } = options;

  const settings = new SettingsStore(database, accountId);
  const repository = new HistoryRepository(database, accountId);
  const conversationImages = new ConversationImageStore(database, options.imagesDir, accountId);
  const credentials = new CredentialStore(
    database,
    new EncryptedSecretVault(database, accountId, options.credentialKey),
    accountId
  );

  const hasVastKey = Boolean(await credentials.get("vastai"));
  const useLiveGpu = options.providerMode === "live" && hasVastKey;

  const compute = useLiveGpu
    ? createVastComputeProvider({
        getApiKey: () => credentials.get("vastai"),
        getHfToken: () => credentials.get("huggingface"),
        getParameterCount: async (modelId) =>
          options.catalogueRepository.get(modelId)?.parameterCount ?? null,
        getFilters: () => settings.get().gpuFilters,
        getReputations: () => options.reputation.snapshot(),
        reportOutcome: (input) => options.reputation.report(input),
        getModelPlan: createModelPlanResolver({
          artifacts: (modelId) => options.catalogueRepository.getArtifacts(modelId),
          loadDetail: (modelId) => options.catalogue.detail(modelId),
          get: (modelId) => options.catalogueRepository.get(modelId),
          engine: (modelId) => options.catalogue.supportFor(modelId)?.engine ?? null
        }),
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

  const reportFailure = createFailureReporter({
    url: process.env.MAIA_FAILURE_REPORT_URL ?? settings.get().diagnosticsUrl,
    appVersion: process.env.MAIA_APP_VERSION ?? "web",
    platform: process.platform,
    retryDelayMs: 0,
    logger
  });

  const sessions = new SessionOrchestrator({
    store: new SessionStore(database, accountId),
    compute,
    inference,
    idleTimeoutMinutes: options.idleTimeoutMinutes ?? 10,
    readinessTimeoutMs: (options.readinessTimeoutMinutes ?? 20) * 60_000,
    filters: () => settings.get().gpuFilters,
    startupRetries: () => settings.get().gpuStartupRetries,
    assertRunnable: async (modelId) => {
      await assertChatRunnable(options.catalogue, modelId);
    },
    capabilityFor: (modelId) =>
      capabilityForPipelineTag(options.catalogueRepository.get(modelId)?.pipelineTag ?? null),
    reportFailure,
    logger
  });

  const registry = new IpcRegistry({
    onError: (channel, error) => {
      logger.error(
        `channel ${channel} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // The browser build has no updater; report idle so old UI keeps working.
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
          return {
            ok,
            message: ok ? "Hugging Face accepted the token." : "Hugging Face rejected the token."
          };
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
    catalogue: options.catalogue,
    sessions,
    history: repository,
    images: conversationImages,
    broadcastChat: (payload) => options.onEvent(accountId, chatEventChannel, payload)
  });

  registry.register("auth.deleteAccount", authDeleteAccountSchema, async (payload, context) => {
    // A GPU must not outlive the account that rented it (Principle II), and the
    // database cascade cannot remove image bytes.
    await sessions.endAll("app_exit");
    await conversationImages.deleteAllForAccount();
    const result = options.access.deleteAccount(accountId, payload);
    context.clearSessionCookie?.();
    return result;
  });

  const idleTimer = setInterval(() => void sessions.reapIdle(), 30_000);
  idleTimer.unref?.();

  return {
    accountId,
    registry,
    orchestrator: sessions,
    images: conversationImages,
    suspend() {
      clearInterval(idleTimer);
    },
    async endSessions(reason) {
      clearInterval(idleTimer);
      await sessions.endAll(reason);
    }
  };
}

function idleUpdateStatus() {
  return {
    phase: "idle" as const,
    currentVersion: "web",
    channel: "stable" as const,
    message: "The web app updates itself when a new version is deployed."
  };
}
