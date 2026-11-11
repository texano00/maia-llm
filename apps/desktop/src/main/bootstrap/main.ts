import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import { release as osRelease } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { updateEventChannel, chatEventChannel } from "@maia/contracts";
import { createModelPlanResolver } from "../services/inference/model-plan-resolver";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../storage/db";
import { HistoryRepository } from "../services/history/repository";
import { ConversationImageStore } from "../services/history/images";
import { CredentialVault } from "../services/credentials/vault";
import { UpdateService, type UpdateLogger } from "../services/updates/updater";
import {
  createElectronUpdater,
  DEFAULT_STABLE_FEED_URL
} from "../services/updates/electron-updater";
import {
  DiagnosticForwarder,
  resolveDiagnosticsEndpoint
} from "../services/diagnostics/forwarder";
import { createFailureReporter } from "../services/diagnostics/failures";
import { SettingsStore } from "../services/settings/store";
import { CatalogueRepository } from "../services/catalogue/repository";
import { CatalogueService } from "../services/catalogue/service";
import { createFixtureCatalogueSource } from "../services/catalogue/fixture-source";
import { createPortalCatalogueSource } from "../services/catalogue/portal-source";
import { createPortalClient, type PortalClient } from "../services/portal/client";
import { PortalCredentialStore } from "../services/portal/credentials";
import { createHuggingFaceSource, testHuggingFaceToken } from "../services/catalogue/huggingface-source";
import { assertChatRunnable } from "../services/catalogue/runnable";
import { createUseCaseResolver } from "../services/catalogue/use-cases";
import { CredentialStore } from "../services/credentials/store";
import { installationFacts } from "../services/telemetry/identity";
import { postUsage, UsageReporter } from "../services/telemetry/usage";
import { NotificationCenter } from "../services/notifications/center";
import { deriveHealthNotifications, HEALTH_NOTIFICATION_KEYS, ProviderHealthMonitor } from "../services/health/monitor";
import { ReadinessNotifier } from "../services/notifications/desktop";
import { createElectronNotificationBackend } from "../services/notifications/electron-backend";
import { ReadinessWatcher } from "../services/notifications/readiness-watcher";
import type { ProviderHealth } from "@maia/contracts";
import { capabilityForPipelineTag, readyEventChannel } from "@maia/contracts";
import { SessionOrchestrator } from "../services/sessions/orchestrator";
import { SessionStore } from "../services/sessions/store";
import { GpuGuardian, guardianPaths } from "../services/sessions/guardian";
import { createMockComputeProvider, createMockInference } from "../services/providers/mock-runtime";
import { createVastComputeProvider } from "../services/providers/vastai/compute-provider";
import { VastAiClient } from "../services/providers/vastai/client";
import { createVllmRuntime } from "../services/inference/vllm";
import { GpuReputationClient } from "../services/gpu/reputation";
import { IpcRegistry } from "../ipc/registry";
import { registerUpdateHandlers } from "../ipc/updates";
import { registerSettingsHandlers } from "../ipc/settings";
import { registerWorkspaceHandlers } from "../ipc/workspace";
import { registerSystemHandlers } from "../ipc/system";
import { loadConfig } from "./config";
import { ensureAppDirectories, resolveAppPaths } from "./paths";
import { enforceSingleInstance, registerLifecycleHooks } from "./lifecycle";
import { QuitCoordinator } from "./quit";
import { createLogger } from "./logging";
import { startCrashReporter } from "./crash-reporter";

let mainWindow: BrowserWindow | null = null;
let database: DatabaseConnection | null = null;
let registry: IpcRegistry | null = null;
let updates: UpdateService | null = null;
let updateTimer: NodeJS.Timeout | null = null;
let diagnostics: DiagnosticForwarder | null = null;
/** Set once the portal client exists; telemetry attaches its installation token. */
let portalClient: PortalClient | null = null;
let appLogger: ReturnType<typeof createLogger>["logger"] | null = null;
let logFlush: (() => void) | null = null;

app.setName("Maia LLM");
app.setAppUserModelId("com.texano00.maiallm");

// A desktop app should not show Electron's default modal for a stray error in a
// log sink or a teardown callback. Record it on stderr and keep the window alive;
// the same message still reaches the diagnostic stream when logging is healthy.
process.on("uncaughtException", (error) => {
  console.error("[maia] uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[maia] unhandled rejection", reason);
});

/**
 * The suite ships its own navigation, so the default Electron menu (File, Edit,
 * View, Window) is removed on Windows and Linux. macOS keeps the minimal app
 * menu it needs for standard shortcuts and quit behavior.
 */
function configureApplicationMenu(): void {
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
    );
    return;
  }

  Menu.setApplicationMenu(null);
}

function createWindow(quit: QuitCoordinator): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#080b12",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  // Closing the window is the usual quit path on Windows and Linux. Ask the
  // coordinator first, otherwise the window would be gone by the time Electron
  // asks about quitting, and there would be nothing on screen to warn with.
  mainWindow.on("close", (event) => {
    if (quit.intercept()) {
      event.preventDefault();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // A sandboxed preload that fails to load leaves the renderer without IPC and
  // every action silently doing nothing. Say so loudly in the logs.
  mainWindow.webContents.once("did-finish-load", () => {
    void mainWindow?.webContents
      .executeJavaScript("typeof window.maia")
      .then((bridgeType: unknown) => {
        if (bridgeType !== "object") {
          logBridgeMissing(bridgeType);
        }
      })
      .catch(() => logBridgeMissing("unavailable"));
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const destination = new URL(url);
      if (destination.protocol === "https:" && destination.hostname === "huggingface.co") {
        void shell.openExternal(destination.toString()).catch((error: unknown) => {
          appLogger?.error("Could not open the Hugging Face model page", {
            reason: error instanceof Error ? error.message : String(error)
          });
        });
      }
    } catch (error) {
      appLogger?.warn("Blocked an invalid external link", {
        reason: error instanceof Error ? error.message : String(error)
      });
    }

    return { action: "deny" };
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function toUpdateLogger(logger: ReturnType<typeof createLogger>["logger"]): UpdateLogger {
  return {
    info: (message, context) => logger.info(message, context),
    warn: (message, context) => logger.warn(message, context),
    error: (message, context) => logger.error(message, context)
  };
}

function logBridgeMissing(bridgeType: unknown): void {
  appLogger?.error("Preload bridge missing: IPC is unavailable in this renderer", {
    bridgeType
  });
}

function scheduleUpdateChecks(service: UpdateService, intervalHours: number): void {
  const run = (): void => {
    void service.check();
  };

  if (mainWindow) {
    mainWindow.webContents.once("did-finish-load", run);
  }

  updateTimer = setInterval(run, intervalHours * 60 * 60 * 1000);
  updateTimer.unref?.();
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const paths = resolveAppPaths();

  await ensureAppDirectories(paths);
  startCrashReporter(paths);

  database = openDatabase(paths.database);
  const settings = new SettingsStore(database);

  // Opt-in usage programme: one content-free sample per completed run.
  const usageReporter = new UsageReporter({
    settings: () => settings.get(),
    facts: () =>
      installationFacts(settings, {
        platform: process.platform,
        arch: process.arch,
        osVersion: osRelease(),
        appVersion: app.getVersion()
      }),
    post: postUsage
  });

  const diagnosticsEndpoint = resolveDiagnosticsEndpoint(
    config.diagnosticLogUrl ?? settings.get().diagnosticsUrl
  );
  /**
   * Telemetry is anonymous while the backend tolerates it, but the installation
   * credential is attached whenever the app has one, so switching
   * `MAIA_REQUIRE_CLIENT_AUTH` on never silences an existing install.
   */
  async function installationHeaders(): Promise<Record<string, string>> {
    const client = portalClient;

    if (!client?.configured()) {
      return {};
    }

    try {
      return { authorization: `Bearer ${await client.accessToken()}` };
    } catch {
      return {};
    }
  }
  diagnostics = diagnosticsEndpoint
    ? new DiagnosticForwarder({
        url: diagnosticsEndpoint,
        appVersion: app.getVersion(),
        platform: process.platform,
        getHeaders: installationHeaders
      })
    : null;

  const { logger, flush: flushLogs } = createLogger(paths, { diagnostics: diagnostics ?? undefined });
  appLogger = logger;
  logFlush = flushLogs;

  // Start-up failures carry the only copy of the container log, so they are
  // reported to the diagnostics service before the instance is destroyed.
  const reportFailure = createFailureReporter({
    url: () =>
      config.diagnosticLogUrl ??
      resolveDiagnosticsEndpoint(settings.get().diagnosticsUrl) ??
      settings.get().diagnosticsUrl,
    appVersion: app.getVersion(),
    platform: process.platform,
    getHeaders: installationHeaders,
    logger
  });

  const repository = new HistoryRepository(database);
  const conversationImages = new ConversationImageStore(database, paths.imagesDir);
  const vault = new CredentialVault(paths.vaultDir);
  const credentials = new CredentialStore(database, vault);

  const catalogueRepository = new CatalogueRepository(database);
  // The published snapshot is the catalogue: it already carries the engine and
  // support verdicts, so the app never lists the Hub itself when the portal is
  // reachable. Without a portal URL it falls back to the Hub live listing.
  const portal = createPortalClient({
    baseUrl: () => config.portalUrl || null,
    credentials: new PortalCredentialStore(join(paths.userData, "portal.json")),
    appVersion: app.getVersion(),
    platform: process.platform,
    logger
  });
  portalClient = portal;

  const catalogue = new CatalogueService({
    repository: catalogueRepository,
    source:
      config.providerMode !== "live"
        ? createFixtureCatalogueSource()
        : portal.configured()
          ? createPortalCatalogueSource({ client: portal })
          : createHuggingFaceSource({ getToken: () => credentials.get("huggingface") }),
    logger,
    ...(config.providerMode === "mock" ? { ttlMs: 0 } : {})
  });

  const reputation = new GpuReputationClient({
    getBaseUrl: () => config.reputationUrl ?? settings.get().diagnosticsUrl,
    logger
  });

  const hasVastKey = Boolean(await credentials.get("vastai"));
  const useLiveGpu = config.providerMode === "live" && hasVastKey;

  const compute = useLiveGpu
    ? createVastComputeProvider({
        getApiKey: () => credentials.get("vastai"),
        getHfToken: () => credentials.get("huggingface"),
        getParameterCount: async (modelId) => catalogueRepository.get(modelId)?.parameterCount ?? null,
        getFilters: () => settings.get().gpuFilters,
        getReputations: () => reputation.snapshot(),
        reportOutcome: (input) => reputation.report(input),
        readyTimeoutMs: config.readinessTimeoutMinutes * 60_000,
        stallTimeoutMs: config.readinessStallMinutes * 60_000,
        // GGUF releases need the loader plugin and a `repo:QUANT` model
        // reference; the plan also sizes `--max-model-len` to this GPU.
        getModelPlan: createModelPlanResolver({
          artifacts: (modelId) => catalogueRepository.getArtifacts(modelId),
          loadDetail: (modelId) => catalogue.detail(modelId),
          get: (modelId) => catalogueRepository.get(modelId),
          // The snapshot says which engine serves this repository; GGUF without
          // a verdict falls back to llama.cpp anyway.
          engine: (modelId) => catalogue.supportFor(modelId)?.engine ?? null
        }),
        logger
      })
    : createMockComputeProvider({ provisionDelayMs: 400 });

  const inference = useLiveGpu
    ? createVllmRuntime({
        resolveEndpoint: (instanceId) =>
          "resolveEndpoint" in compute ? compute.resolveEndpoint(instanceId) : null
      })
    : createMockInference({ chunkDelayMs: 12 });

  const sessionStore = new SessionStore(database);
  const sessions = new SessionOrchestrator({
    store: sessionStore,
    compute,
    inference,
    idleTimeoutMinutes: config.idleTimeoutMinutes,
    readinessTimeoutMs: config.readinessTimeoutMinutes * 60_000,
    filters: () => settings.get().gpuFilters,
    startupRetries: () => settings.get().gpuStartupRetries,
    assertRunnable: async (modelId) => {
      // Refuses embedding models (no chat endpoint) and base models such as gpt2
      // (no chat template) before the user pays for a boot.
      await assertChatRunnable(catalogue, modelId);
    },
    isGatedModel: (modelId) => catalogueRepository.get(modelId)?.gated !== "none",
    capabilityFor: (modelId) =>
      capabilityForPipelineTag(catalogueRepository.get(modelId)?.pipelineTag ?? null),
    reportFailure,
    onRunFinished: (session) => {
      const metric = sessionStore.metricFor(session.id);
      if (metric) {
        void usageReporter.report(session, metric);
      }
    },
    logger
  });

  // Reclaiming instances talks to vast.ai; it must not delay the first paint.
  const reconcileTask = sessions
    .reconcile()
    .then((reconciled) => {
      if (reconciled > 0) {
        logger.warn("Released sessions left behind by a previous run", { reconciled });
      }
    })
    .catch((error: unknown) => {
      logger.warn(
          "Could not reconcile sessions on startup",
          { reason: error instanceof Error ? error.message : String(error) }
        );
    });

  const idleTimer = setInterval(() => {
    void sessions.reapIdle();
  }, 30_000);
  idleTimer.unref?.();

  configureApplicationMenu();

  const updateLogger = toUpdateLogger(logger);
  const isBeta = config.releaseChannel === "beta";
  updates = new UpdateService({
    currentVersion: app.getVersion(),
    channel: config.releaseChannel,
    updater: createElectronUpdater(updateLogger, {
      feedUrl: config.updateFeedUrl ?? (isBeta ? undefined : DEFAULT_STABLE_FEED_URL),
      allowPrerelease: isBeta
    }),
    logger: updateLogger,
    simulatedVersion: config.simulatedUpdateVersion,
    onStatus: (status) => {
      mainWindow?.webContents.send(updateEventChannel, status);
    }
  });

  registry = new IpcRegistry({
    onError: (channel, error) => {
      logger.error("IPC handler failed", {
        channel,
        reason: error instanceof Error ? error.message : String(error),
        code: error !== null && typeof error === "object" && "code" in error ? error.code : undefined
      });
    }
  });
  registry.register("app.info", z.unknown(), () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    channel: config.releaseChannel,
    packaged: app.isPackaged
  }));
  registerUpdateHandlers(registry, updates);
  let lastUsageReporting = settings.get().usageReporting;
  registerSettingsHandlers({
    registry,
    store: settings,
    credentials,
    onChange: (next) => {
      const endpoint = resolveDiagnosticsEndpoint(next.diagnosticsUrl);
      if (endpoint && diagnostics) {
        diagnostics.setUrl(endpoint);
      }
      if (next.usageReporting !== lastUsageReporting) {
        void usageReporter.preference(next.usageReporting);
        lastUsageReporting = next.usageReporting;
      }
    },
    testCredential: async (provider, secret) => {
      try {
        if (provider === "huggingface") {
          const ok = await testHuggingFaceToken(secret);
          return ok
            ? { ok: true, message: "Hugging Face accepted the token." }
            : { ok: false, message: "Hugging Face rejected the token." };
        }

        if (provider === "vastai") {
          const ok = await new VastAiClient(secret).testConnection();
          return ok
            ? { ok: true, message: "vast.ai accepted the API key." }
            : { ok: false, message: "vast.ai rejected the API key." };
        }

        return { ok: false, message: `${provider} connection tests are not wired yet.` };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : `${provider} request failed`
        };
      }
    }
  });
  // Header health surface: one snapshot feeds the bell, the balance badge and the
  // missing-key prompts. Provider checks never throw; `unknown` is a valid state.
  const notifications = new NotificationCenter(settings);

  // Resolved conditions disappear from the bell; their dismissal also resets so a
  // recurrence notifies again.
  function syncHealth(snapshot: ProviderHealth): void {
    const entries = deriveHealthNotifications(snapshot);
    const active = new Set(entries.map((entry) => entry.key));
    for (const key of HEALTH_NOTIFICATION_KEYS) {
      if (!active.has(key)) {
        notifications.clear(key);
      }
    }
    for (const entry of entries) {
      notifications.set(entry);
    }
  }

  const health = new ProviderHealthMonitor({
    hasHuggingFace: async () => Boolean(await credentials.get("huggingface")),
    verifyHuggingFace: async () => {
      const secret = await credentials.get("huggingface");
      return secret ? testHuggingFaceToken(secret) : false;
    },
    hasVastai: async () => Boolean(await credentials.get("vastai")),
    verifyVastai: async () => {
      const secret = await credentials.get("vastai");
      return secret ? new VastAiClient(secret).testConnection() : false;
    },
    getBalanceMicroUsd: async () => {
      const secret = await credentials.get("vastai");
      return secret ? new VastAiClient(secret).getBalanceMicroUsd() : null;
    },
    getThresholdMicroUsd: () => settings.get().walletWarnThresholdMicroUsd
  });
  registerSystemHandlers({ registry, notifications, health, onHealth: syncHealth });
  void health.refresh().then(syncHealth);

  // One OS notification per run that becomes ready while Maia is in the
  // background; clicking it brings the window forward on the run list.
  const readinessNotifier = new ReadinessNotifier({
    backend: createElectronNotificationBackend(),
    isFocused: () => Boolean(mainWindow?.isFocused()),
    onActivate: (sessionId) => {
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.webContents.send(readyEventChannel, { sessionId });
    },
    onUnsupported: () =>
      notifications.set({
        key: "desktop:unsupported",
        severity: "warning",
        message: "Allow system notifications for Maia LLM to be told when a model is ready.",
        action: { label: "Open settings", route: "/settings" }
      })
  });
  const readinessWatcher = new ReadinessWatcher({
    listSessions: () => sessions.listSessions(),
    notifier: readinessNotifier
  });
  readinessWatcher.start();

  registerWorkspaceHandlers({
    registry,
    catalogue,
    sessions,
    history: repository,
    images: conversationImages,
    useCases: createUseCaseResolver({
      list: portal.configured() ? () => portal.useCases() : null,
      catalogue,
      logger
    }),
    broadcastChat: (payload) => {
      mainWindow?.webContents.send(chatEventChannel, payload);
    }
  });
  registry.install();

  logger.info("Application services initialized", {
    providerMode: config.providerMode,
    releaseChannel: config.releaseChannel,
    database: paths.database,
    conversations: repository.listConversations(1).length,
    vaultDirectory: paths.vaultDir,
    updateCheckIntervalHours: config.updateCheckIntervalHours,
    diagnosticsEndpoint: diagnostics?.getUrl() ?? null,
    credentials: credentials.status()
  });

  void vault;

  // A detached process owns the clean-up if this one disappears without running
  // the shutdown sequence (crash, "End task", `kill -9`).
  const guardian = new GpuGuardian({
    ...guardianPaths(paths.userData),
    scriptPath: join(__dirname, "guardian.js"),
    getApiKey: () => credentials.get("vastai"),
    logger
  });

  if (useLiveGpu) {
    await guardian.start();
    guardian.startSyncing(() =>
      sessions
        .listSessions()
        .filter((session) => session.instanceId !== null)
        .map((session) => ({ instanceId: session.instanceId as number, label: session.label }))
    );

    const previous = guardian.takeReport();
    if (previous) {
      logger.warn("The GPU guardian released instances after the previous run ended unexpectedly", {
        released: previous.released,
        failed: previous.failed,
        finishedAt: previous.finishedAt
      });
    }
  }

  const quit = new QuitCoordinator({
    describeRunningGpus: () => {
      const running = sessions
        .listSessions()
        .filter((session) => session.instanceId !== null || session.state === "provisioning");

      return {
        count: running.length,
        detail: running
          .map(
            (session) =>
              `• ${session.gpuName ?? "GPU"}${
                session.instanceId === null ? " (booting)" : ` #${session.instanceId}`
              } — ${session.modelId}`
          )
          .join("\n")
      };
    },
    confirm: async (summary) => {
      const options = {
        type: "warning" as const,
        buttons: ["Keep the app open", "Shut down GPUs and quit"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: "Shut down the running GPUs?",
        message:
          summary.count === 1
            ? "Closing Maia LLM will shut down the GPU it is renting."
            : `Closing Maia LLM will shut down the ${summary.count} GPUs it is renting.`,
        detail: `${summary.detail}\n\nBilling stops as soon as the instance is destroyed. Nothing is kept running in the background.`
      };

      const choice =
        mainWindow === null
          ? dialog.showMessageBoxSync(options)
          : dialog.showMessageBoxSync(mainWindow, options);

      return choice === 1;
    },
    releaseGpus: () => sessions.endAll("app_exit"),
    dispose: () => {
      if (updateTimer) {
        clearInterval(updateTimer);
        updateTimer = null;
      }

      clearInterval(idleTimer);
      void guardian.dispose();

      updates?.dispose();
      updates = null;
      diagnostics?.stop();
      diagnostics = null;
      registry?.dispose();
      if (database) {
        closeDatabase(database);
        database = null;
      }

      // The file destination is asynchronous now, so the tail must be written out.
      logFlush?.();
    },
    quit: () => app.quit(),
    logger
  });

  registerLifecycleHooks(quit);

  // The window comes first: services that touch the network (reconcile, update
  // checks) finish in the background instead of delaying the first paint.
  createWindow(quit);
  void reconcileTask;
  scheduleUpdateChecks(updates, config.updateCheckIntervalHours);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(quit);
    }
  });
}

if (!enforceSingleInstance()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  void app.whenReady().then(bootstrap);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
