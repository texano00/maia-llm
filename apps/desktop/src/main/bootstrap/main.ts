import { app, BrowserWindow, dialog, Menu } from "electron";
import { join } from "node:path";
import { z } from "zod";
import {
  updateEventChannel,
  chatEventChannel,
  isChatCapableModel,
  isGgufOnlyRepository
} from "@maia/contracts";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../storage/db";
import { HistoryRepository } from "../services/history/repository";
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
import { SettingsStore } from "../services/settings/store";
import { CatalogueRepository } from "../services/catalogue/repository";
import { CatalogueService } from "../services/catalogue/service";
import { createFixtureCatalogueSource } from "../services/catalogue/fixture-source";
import { createHuggingFaceSource, testHuggingFaceToken } from "../services/catalogue/huggingface-source";
import { CredentialStore } from "../services/credentials/store";
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

  const diagnosticsEndpoint = resolveDiagnosticsEndpoint(
    config.diagnosticLogUrl ?? settings.get().diagnosticsUrl
  );
  diagnostics = diagnosticsEndpoint
    ? new DiagnosticForwarder({
        url: diagnosticsEndpoint,
        appVersion: app.getVersion(),
        platform: process.platform
      })
    : null;

  const { logger, flush: flushLogs } = createLogger(paths, { diagnostics: diagnostics ?? undefined });
  appLogger = logger;
  logFlush = flushLogs;

  const repository = new HistoryRepository(database);
  const vault = new CredentialVault(paths.vaultDir);
  const credentials = new CredentialStore(database, vault);

  const catalogueRepository = new CatalogueRepository(database);
  const catalogue = new CatalogueService({
    repository: catalogueRepository,
    source:
      config.providerMode === "live"
        ? createHuggingFaceSource({ getToken: () => credentials.get("huggingface") })
        : createFixtureCatalogueSource(),
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
    idleTimeoutMinutes: config.idleTimeoutMinutes,
    readinessTimeoutMs: config.readinessTimeoutMinutes * 60_000,
    filters: () => settings.get().gpuFilters,
    assertRunnable: async (modelId) => {
      const model = catalogue.get(modelId);
      if (model && !isChatCapableModel(model)) {
        throw new Error(
          `"${model.id}" is a ${model.pipelineTag} model, not a chat model. Pick a text-generation model to start a chat session.`
        );
      }

      // GGUF is a llama.cpp quantisation: host it and vLLM exits during startup,
      // long after the instance started billing.
      let artifacts = catalogueRepository.getArtifacts(modelId);
      if (artifacts.length === 0) {
        artifacts = await catalogue.detail(modelId).then(
          (detail) => detail.artifacts,
          () => []
        );
      }

      if (isGgufOnlyRepository(artifacts)) {
        throw new Error(
          `"${modelId}" only ships GGUF weights, which vLLM cannot load. Pick a repository with .safetensors weights (publishers usually ship both).`
        );
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
  registerSettingsHandlers({
    registry,
    store: settings,
    credentials,
    onChange: (next) => {
      const endpoint = resolveDiagnosticsEndpoint(next.diagnosticsUrl);
      if (endpoint && diagnostics) {
        diagnostics.setUrl(endpoint);
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
  registerWorkspaceHandlers({
    registry,
    catalogue,
    sessions,
    history: repository,
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
