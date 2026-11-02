import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { z } from "zod";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../storage/db";
import { HistoryRepository } from "../services/history/repository";
import { CredentialVault } from "../services/credentials/vault";
import { IpcRegistry } from "../ipc/registry";
import { loadConfig } from "./config";
import { ensureAppDirectories, resolveAppPaths } from "./paths";
import { enforceSingleInstance, registerLifecycleHooks } from "./lifecycle";
import { createLogger } from "./logging";
import { startCrashReporter } from "./crash-reporter";

let mainWindow: BrowserWindow | null = null;
let database: DatabaseConnection | null = null;
let registry: IpcRegistry | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
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

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const paths = resolveAppPaths();

  await ensureAppDirectories(paths);
  startCrashReporter(paths);

  const logger = createLogger(paths);
  database = openDatabase(paths.database);

  const repository = new HistoryRepository(database);
  const vault = new CredentialVault(paths.vaultDir);

  registry = new IpcRegistry();
  registry.register("app.info", z.unknown(), () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform
  }));
  registry.install();

  logger.info(
    {
      providerMode: config.providerMode,
      releaseChannel: config.releaseChannel,
      database: paths.database,
      conversations: repository.listConversations(1).length,
      vaultDirectory: paths.vaultDir
    },
    "Application services initialized"
  );

  void vault;

  registerLifecycleHooks(() => {
    registry?.dispose();
    if (database) {
      closeDatabase(database);
      database = null;
    }
  });

  createWindow();

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
