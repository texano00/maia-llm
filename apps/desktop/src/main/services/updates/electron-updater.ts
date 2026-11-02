import { autoUpdater } from "electron-updater";
import type { UpdateLogger, UpdaterLike } from "./updater";

/**
 * Adapts the pino-backed logger to the `electron-updater` logger contract and
 * keeps auto-download off: the renderer decides when bytes are spent.
 */
export function createElectronUpdater(logger?: UpdateLogger): UpdaterLike {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (message?: unknown) => logger?.info(stringify(message)),
    warn: (message?: unknown) => logger?.warn(stringify(message)),
    error: (message?: unknown) => logger?.error(stringify(message)),
    debug: (message?: unknown) => logger?.info(stringify(message))
  } as unknown as typeof autoUpdater.logger;

  return autoUpdater as unknown as UpdaterLike;
}

function stringify(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }

  if (message instanceof Error) {
    return message.message;
  }

  return String(message);
}
