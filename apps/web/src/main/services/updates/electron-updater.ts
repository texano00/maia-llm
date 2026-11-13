import { autoUpdater } from "electron-updater";
import type { UpdateLogger, UpdaterLike } from "./updater";

/**
 * Stable builds read a generic feed that points at the "latest" release assets.
 * That is a single `latest.yml` fetch plus the installer download, without the
 * Atom-feed and HTML redirect lookups the GitHub provider performs, which is
 * faster and less sensitive to corporate proxies.
 */
export const DEFAULT_STABLE_FEED_URL =
  "https://github.com/texano00/maia-llm/releases/latest/download";

export interface ElectronUpdaterOptions {
  /** Overrides the default feed URL (for example a self-hosted mirror). */
  feedUrl?: string | undefined;
  /** Beta builds keep the GitHub provider, which understands prereleases. */
  allowPrerelease?: boolean | undefined;
}

/**
 * Adapts the pino-backed logger to the `electron-updater` logger contract and
 * keeps auto-download off: the renderer decides when bytes are spent.
 */
export function createElectronUpdater(
  logger?: UpdateLogger,
  options: ElectronUpdaterOptions = {}
): UpdaterLike {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = options.allowPrerelease ?? false;
  // We ship a full NSIS installer, never a web installer.
  autoUpdater.disableWebInstaller = true;
  autoUpdater.logger = {
    info: (message?: unknown) => logger?.info(stringify(message)),
    warn: (message?: unknown) => logger?.warn(stringify(message)),
    error: (message?: unknown) => logger?.error(stringify(message)),
    debug: (message?: unknown) => logger?.info(stringify(message))
  } as unknown as typeof autoUpdater.logger;

  if (options.feedUrl) {
    // GitHub release assets answer a multi-range request with HTTP 501, so the
    // updater always falls back to a full download for this feed. That is fine
    // for dev builds; the release phase will move to a range-capable mirror.
    autoUpdater.setFeedURL({ provider: "generic", url: options.feedUrl });
    logger?.info("Using a generic update feed", { feedUrl: options.feedUrl });
  }

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
