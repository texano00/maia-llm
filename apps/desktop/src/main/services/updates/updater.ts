import type { ReleaseChannel, UpdateStatus } from "@maia/contracts";

/**
 * Minimal surface of `electron-updater`'s `AppUpdater` that this service relies
 * on. Keeping it structural lets the unit tests exercise every transition
 * without loading Electron or hitting the network.
 */
export interface UpdaterReleaseNotesEntry {
  version: string;
  note: string | null;
}

export interface UpdaterReleaseInfo {
  version: string;
  releaseName?: string | null;
  releaseNotes?: string | UpdaterReleaseNotesEntry[] | null;
  releaseDate?: string;
}

export interface UpdaterCheckResult {
  updateInfo?: UpdaterReleaseInfo | null;
}

export interface UpdaterDownloadProgress {
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
}

export type UpdaterEvent =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  on(event: UpdaterEvent, listener: (payload?: unknown) => void): unknown;
  removeListener?(event: UpdaterEvent, listener: (payload?: unknown) => void): unknown;
  checkForUpdates(): Promise<UpdaterCheckResult | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  channel: ReleaseChannel;
  updater: UpdaterLike;
  onStatus?: ((status: UpdateStatus) => void) | undefined;
  logger?: UpdateLogger | undefined;
  /** Development hook: report this version as available without a network call. */
  simulatedVersion?: string | undefined;
  /** False when the build cannot self-update; callers can pre-empt the failure. */
  supported?: boolean | undefined;
  now?: (() => Date) | undefined;
  /** Guards against a feed request that never settles. */
  checkTimeoutMs?: number | undefined;
  downloadTimeoutMs?: number | undefined;
}

const DEFAULT_CHECK_TIMEOUT_MS = 20_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

const MAX_RELEASE_NOTES_LENGTH = 1200;

export class UpdateService {
  private readonly currentVersion: string;
  private readonly channel: ReleaseChannel;
  private readonly updater: UpdaterLike;
  private readonly onStatus: ((status: UpdateStatus) => void) | undefined;
  private readonly logger: UpdateLogger | undefined;
  private readonly simulatedVersion: string | undefined;
  private readonly now: () => Date;
  private readonly checkTimeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly listeners: Array<{ event: UpdaterEvent; listener: (payload?: unknown) => void }> = [];

  private status: UpdateStatus;
  private inFlightCheck: Promise<UpdateStatus> | null = null;

  constructor(options: UpdateServiceOptions) {
    this.currentVersion = options.currentVersion;
    this.channel = options.channel;
    this.updater = options.updater;
    this.onStatus = options.onStatus;
    this.logger = options.logger;
    this.simulatedVersion = options.simulatedVersion;
    this.now = options.now ?? (() => new Date());
    this.checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

    this.status = {
      phase: "idle",
      currentVersion: options.currentVersion,
      channel: options.channel,
      supported: options.supported ?? true
    };

    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = true;
    this.updater.allowPrerelease = options.channel === "beta";
    this.attachListeners();
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  async check(): Promise<UpdateStatus> {
    if (this.inFlightCheck) {
      return this.inFlightCheck;
    }

    if (this.status.phase === "downloading" || this.status.phase === "ready") {
      return this.getStatus();
    }

    this.inFlightCheck = this.runCheck().finally(() => {
      this.inFlightCheck = null;
    });

    return this.inFlightCheck;
  }

  async download(): Promise<UpdateStatus> {
    if (this.status.phase !== "available") {
      return this.getStatus();
    }

    this.update({ phase: "downloading", progressPercent: 0, bytesPerSecond: undefined });

    try {
      await withTimeout(
        this.updater.downloadUpdate(),
        this.downloadTimeoutMs,
        "The update download stalled. Check the network connection and try again."
      );
    } catch (error) {
      this.fail(error, "Update download failed");
    }

    return this.getStatus();
  }

  install(): UpdateStatus {
    if (this.status.phase !== "ready") {
      return this.getStatus();
    }

    this.logger?.info("Restarting to apply update", { version: this.status.latestVersion });
    // Silent install: setup reuses the detected folder and shows no UI while the
    // user is already in the app. The second flag relaunches Maia afterwards.
    this.updater.quitAndInstall(true, true);
    return this.getStatus();
  }

  dispose(): void {
    for (const { event, listener } of this.listeners) {
      this.updater.removeListener?.(event, listener);
    }

    this.listeners.length = 0;
  }

  private async runCheck(): Promise<UpdateStatus> {
    if (this.simulatedVersion) {
      this.logger?.warn("Reporting a simulated update", { version: this.simulatedVersion });
      return this.update({
        phase: "available",
        latestVersion: this.simulatedVersion,
        releaseNotes: "Simulated update used for local verification of the update banner.",
        checkedAt: this.timestamp(),
        errorMessage: undefined
      });
    }

    this.update({ phase: "checking", errorMessage: undefined });

    try {
      const result = await withTimeout(
        this.updater.checkForUpdates(),
        this.checkTimeoutMs,
        `No response from the update feed after ${Math.round(this.checkTimeoutMs / 1000)} s. Check the network connection or proxy settings.`
      );

      if (result === null) {
        return this.update({ phase: "idle", supported: false });
      }

      if (this.status.phase === "checking") {
        if (result.updateInfo?.version) {
          this.applyRelease(result.updateInfo, { bumpProgress: false });
        } else {
          this.update({
            phase: "up-to-date",
            checkedAt: this.timestamp(),
            latestVersion: this.currentVersion
          });
        }
      }

      this.logger?.info("Update check finished", { phase: this.status.phase });
    } catch (error) {
      this.fail(error, "Update check failed");
    }

    return this.getStatus();
  }

  private attachListeners(): void {
    this.listen("checking-for-update", () => {
      if (this.status.phase !== "downloading" && this.status.phase !== "ready") {
        this.update({ phase: "checking" });
      }
    });

    this.listen("update-available", (payload) => {
      this.applyRelease(payload as UpdaterReleaseInfo, { bumpProgress: false });
    });

    this.listen("update-not-available", (payload) => {
      if (this.simulatedVersion) {
        return;
      }

      this.update({
        phase: "up-to-date",
        checkedAt: this.timestamp(),
        latestVersion: this.pickVersion(payload) ?? this.currentVersion
      });
    });

    this.listen("download-progress", (payload) => {
      const progress = payload as UpdaterDownloadProgress;
      this.update({
        phase: "downloading",
        progressPercent: clampPercent(progress.percent),
        bytesPerSecond: progress.bytesPerSecond
      });
    });

    this.listen("update-downloaded", (payload) => {
      this.applyRelease(payload as UpdaterReleaseInfo, { bumpProgress: true });
    });

    this.listen("error", (payload) => {
      this.fail(payload, "Updater error");
    });
  }

  private listen(event: UpdaterEvent, listener: (payload?: unknown) => void): void {
    this.updater.on(event, listener);
    this.listeners.push({ event, listener });
  }

  private applyRelease(info: UpdaterReleaseInfo, options: { bumpProgress: boolean }): void {
    if (!info?.version) {
      return;
    }

    const alreadyDownloaded = options.bumpProgress || this.status.phase === "ready";

    this.update({
      phase: alreadyDownloaded ? "ready" : "available",
      latestVersion: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      releaseDate: info.releaseDate,
      progressPercent: alreadyDownloaded ? 100 : undefined,
      bytesPerSecond: undefined,
      checkedAt: this.timestamp(),
      errorMessage: undefined
    });
  }

  private fail(error: unknown, fallbackMessage: string): void {
    const message = describeUpdateError(error, fallbackMessage);
    this.logger?.error("Update workflow failed", { message });
    this.update({ phase: "error", errorMessage: message });
  }

  private pickVersion(payload: unknown): string | undefined {
    if (payload && typeof payload === "object" && "version" in payload) {
      const version = (payload as { version?: unknown }).version;
      return typeof version === "string" ? version : undefined;
    }

    return undefined;
  }

  private update(patch: Partial<UpdateStatus>): UpdateStatus {
    const next: UpdateStatus = { ...this.status, ...patch };
    const changed = JSON.stringify(next) !== JSON.stringify(this.status);
    this.status = next;

    if (changed) {
      this.onStatus?.(this.getStatus());
    }

    return this.getStatus();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function clampPercent(value: number | undefined): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }

  return Math.min(100, Math.max(0, Math.round(value)));
}

function normalizeReleaseNotes(
  notes: UpdaterReleaseInfo["releaseNotes"]
): string | undefined {
  if (!notes) {
    return undefined;
  }

  const text = Array.isArray(notes)
    ? notes
        .map((entry) => [entry.version ? `v${entry.version}` : "", entry.note ?? ""].filter(Boolean).join(" "))
        .filter(Boolean)
        .join("\n\n")
    : notes;

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return trimmed.length > MAX_RELEASE_NOTES_LENGTH
    ? `${trimmed.slice(0, MAX_RELEASE_NOTES_LENGTH - 1)}…`
    : trimmed;
}

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return fallback;
}

/**
 * The update transports have no timeout of their own, so a stalled socket would
 * leave the UI on "checking" forever. Race every network step against a timer.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Turns transport failures into something a user can act on. The feed lives in a
 * GitHub Release, so a 404 usually means the release is a draft, the repository
 * is private, or no release was published yet.
 */
function describeUpdateError(error: unknown, fallback: string): string {
  const raw = toMessage(error, fallback);

  if (/\b404\b/.test(raw)) {
    return "The update feed was not found (HTTP 404). Draft releases, private repositories, and releases without latest.yml are not readable by the app.";
  }

  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ETIMEDOUT/i.test(raw)) {
    return "The update feed is unreachable. Check the network connection and try again.";
  }

  return raw;
}
