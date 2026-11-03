import { app, BrowserWindow, Menu } from "electron";
import { join } from "node:path";
import { z } from "zod";
import { updateEventChannel, chatEventChannel } from "@maia/contracts";
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
import { createMockComputeProvider, createMockInference } from "../services/providers/mock-runtime";
import { IpcRegistry } from "../ipc/registry";
import { registerUpdateHandlers } from "../ipc/updates";
import { registerSettingsHandlers } from "../ipc/settings";
import { registerWorkspaceHandlers } from "../ipc/workspace";
import { loadConfig } from "./config";
import { ensureAppDirectories, resolveAppPaths } from "./paths";
import { enforceSingleInstance, registerLifecycleHooks } from "./lifecycle";
import { createLogger } from "./logging";
import { startCrashReporter } from "./crash-reporter";

let mainWindow: BrowserWindow | null = null;
let database: DatabaseConnection | null = null;
let registry: IpcRegistry | null = null;
let updates: UpdateService | null = null;
let updateTimer: NodeJS.Timeout | null = null;
let diagnostics: DiagnosticForwarder | null = null;
let appLogger: ReturnType<typeof createLogger> | null = null;

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

function createWindow(): void {
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

function toUpdateLogger(logger: ReturnType<typeof createLogger>): UpdateLogger {
  return {
    info: (message, context) => logger.info(context ?? {}, message),
    warn: (message, context) => logger.warn(context ?? {}, message),
    error: (message, context) => logger.error(context ?? {}, message)
  };
}

function logBridgeMissing(bridgeType: unknown): void {
  appLogger?.error(
    { bridgeType },
    "Preload bridge missing: IPC is unavailable in this renderer"
  );
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

  const logger = createLogger(paths, { diagnostics: diagnostics ?? undefined });
  appLogger = logger;

  const repository = new HistoryRepository(database);
  const vault = new CredentialVault(paths.vaultDir);
  const credentials = new CredentialStore(database, vault);

  const catalogue = new CatalogueService({
    repository: new CatalogueRepository(database),
    source:
      config.providerMode === "live"
        ? createHuggingFaceSource({ getToken: () => credentials.get("huggingface") })
        : createFixtureCatalogueSource(),
    logger,
    ...(config.providerMode === "mock" ? { ttlMs: 0 } : {})
  });

  const sessions = new SessionOrchestrator({
    store: new SessionStore(database),
    compute: createMockComputeProvider({ provisionDelayMs: 400 }),
    inference: createMockInference({ chunkDelayMs: 12 }),
    idleTimeoutMinutes: config.idleTimeoutMinutes,
    filters: () => settings.get().gpuFilters,
    logger
  });

  const reconciled = await sessions.reconcile();
  if (reconciled > 0) {
    logger.warn({ reconciled }, "Released sessions left behind by a previous run");
  }

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

  registry = new IpcRegistry();
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
      if (provider !== "huggingface") {
        return { ok: false, message: `${provider} connection tests are not wired yet.` };
      }

      try {
        const ok = await testHuggingFaceToken(secret);
        return ok
          ? { ok: true, message: "Hugging Face accepted the token." }
          : { ok: false, message: "Hugging Face rejected the token." };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Hugging Face request failed"
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

  logger.info(
    {
      providerMode: config.providerMode,
      releaseChannel: config.releaseChannel,
      database: paths.database,
      conversations: repository.listConversations(1).length,
      vaultDirectory: paths.vaultDir,
      updateCheckIntervalHours: config.updateCheckIntervalHours,
      diagnosticsEndpoint: diagnostics?.getUrl() ?? null,
      credentials: credentials.status()
    },
    "Application services initialized"
  );

  void vault;

  registerLifecycleHooks(() => {
    if (updateTimer) {
      clearInterval(updateTimer);
      updateTimer = null;
    }

    clearInterval(idleTimer);

    // Never leave a chargeable GPU running after the app exits (FR-073).
    void sessions.endAll("app_exit");

    updates?.dispose();
    updates = null;
    diagnostics?.stop();
    diagnostics = null;
    registry?.dispose();
    if (database) {
      closeDatabase(database);
      database = null;
    }
  });

  createWindow();
  scheduleUpdateChecks(updates, config.updateCheckIntervalHours);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
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
