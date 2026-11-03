import { app, BrowserWindow, Menu } from "electron";
import { join } from "node:path";
import { z } from "zod";
import { updateEventChannel } from "@maia/contracts";
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
import { IpcRegistry } from "../ipc/registry";
import { registerUpdateHandlers } from "../ipc/updates";
import { registerSettingsHandlers } from "../ipc/settings";
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
  registerSettingsHandlers(registry, settings, (next) => {
    const endpoint = resolveDiagnosticsEndpoint(next.diagnosticsUrl);
    if (endpoint && diagnostics) {
      diagnostics.setUrl(endpoint);
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
      diagnosticsEndpoint: diagnostics?.getUrl() ?? null
    },
    "Application services initialized"
  );

  void vault;

  registerLifecycleHooks(() => {
    if (updateTimer) {
      clearInterval(updateTimer);
      updateTimer = null;
    }

    updates?.dispose();
    updates = null;
    diagnostics?.end();
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
