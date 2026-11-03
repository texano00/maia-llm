import { describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "@maia/contracts";
import {
  UpdateService,
  type UpdateServiceOptions,
  type UpdaterCheckResult,
  type UpdaterEvent,
  type UpdaterLike,
  type UpdaterReleaseInfo
} from "../../src/main/services/updates/updater";

type Listener = (payload?: unknown) => void;

class FakeUpdater implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;

  checkResult: UpdaterCheckResult | null = { updateInfo: { version: "0.2.0" } };
  checkError: Error | null = null;
  downloadError: Error | null = null;
  holdCheck = false;
  checkCalls = 0;
  downloadCalls = 0;
  quitCalls: Array<{ isSilent?: boolean; isForceRunAfter?: boolean }> = [];

  private readonly listeners = new Map<UpdaterEvent, Set<Listener>>();

  on(event: UpdaterEvent, listener: Listener): this {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  removeListener(event: UpdaterEvent, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: UpdaterEvent, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }

  async checkForUpdates(): Promise<UpdaterCheckResult | null> {
    this.checkCalls += 1;
    if (this.checkError) {
      throw this.checkError;
    }

    if (this.holdCheck) {
      return new Promise<UpdaterCheckResult | null>(() => undefined);
    }

    this.emit("checking-for-update");
    const info = this.checkResult?.updateInfo;
    if (info) {
      this.emit("update-available", info);
    } else {
      this.emit("update-not-available", { version: "0.1.0" });
    }

    return this.checkResult;
  }

  async downloadUpdate(): Promise<void> {
    this.downloadCalls += 1;
    if (this.downloadError) {
      throw this.downloadError;
    }

    await Promise.resolve();

    this.emit("download-progress", { percent: 42.6, bytesPerSecond: 2_097_152 });
    this.emit("update-downloaded", { version: this.checkResult?.updateInfo?.version ?? "0.2.0" });
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.quitCalls.push({ isSilent, isForceRunAfter });
  }
}

function createService(updater: FakeUpdater, overrides: Partial<UpdateServiceOptions> = {}) {
  const statuses: UpdateStatus[] = [];
  const service = new UpdateService({
    currentVersion: "0.1.0",
    channel: "stable",
    updater,
    onStatus: (status) => statuses.push(status),
    now: () => new Date("2026-11-02T10:00:00.000Z"),
    ...overrides
  });

  return { service, statuses };
}

describe("UpdateService", () => {
  it("keeps manual download control and follows the release channel", () => {
    const stableUpdater = new FakeUpdater();
    createService(stableUpdater);

    expect(stableUpdater.autoDownload).toBe(false);
    expect(stableUpdater.autoInstallOnAppQuit).toBe(true);
    expect(stableUpdater.allowPrerelease).toBe(false);

    const betaUpdater = new FakeUpdater();
    createService(betaUpdater, { channel: "beta" });

    expect(betaUpdater.allowPrerelease).toBe(true);
  });

  it("reports an available update with normalised release notes", async () => {
    const updater = new FakeUpdater();
    updater.checkResult = {
      updateInfo: {
        version: "0.2.0",
        releaseNotes: [
          { version: "0.2.0", note: "GPU catalogue" },
          { version: "0.1.5", note: null }
        ],
        releaseDate: "2026-11-01T00:00:00.000Z"
      }
    };

    const { service, statuses } = createService(updater);
    const status = await service.check();

    expect(updater.checkCalls).toBe(1);
    expect(status.phase).toBe("available");
    expect(status.latestVersion).toBe("0.2.0");
    expect(status.releaseNotes).toContain("v0.2.0 GPU catalogue");
    expect(status.releaseDate).toBe("2026-11-01T00:00:00.000Z");
    expect(status.checkedAt).toBe("2026-11-02T10:00:00.000Z");
    expect(statuses.some((entry) => entry.phase === "checking")).toBe(true);
    expect(statuses.at(-1)?.phase).toBe("available");
  });

  it("reports up-to-date when the feed has no newer version", async () => {
    const updater = new FakeUpdater();
    updater.checkResult = { updateInfo: null };

    const { service } = createService(updater);

    await expect(service.check()).resolves.toMatchObject({
      phase: "up-to-date",
      latestVersion: "0.1.0"
    });
  });

  it("marks the build as not self-updatable when the updater is inactive", async () => {
    const updater = new FakeUpdater();
    updater.checkResult = null;

    const { service } = createService(updater);

    await expect(service.check()).resolves.toMatchObject({ phase: "idle", supported: false });
  });

  it("surfaces check failures without throwing", async () => {
    const updater = new FakeUpdater();
    updater.checkError = new Error("net::ERR_INTERNET_DISCONNECTED");

    const { service } = createService(updater);

    await expect(service.check()).resolves.toMatchObject({
      phase: "error",
      errorMessage: "net::ERR_INTERNET_DISCONNECTED"
    });
  });

  it("explains an unreachable feed instead of leaking a bare HTTP status", async () => {
    const updater = new FakeUpdater();
    updater.checkError = new Error("HttpError: 404 Not Found");

    const { service } = createService(updater);
    const status = await service.check();

    expect(status.phase).toBe("error");
    expect(status.errorMessage).toContain("HTTP 404");
    expect(status.errorMessage).toContain("private repositories");
  });

  it("times out instead of staying on \"checking\" forever", async () => {
    const updater = new FakeUpdater();
    updater.holdCheck = true;

    const { service } = createService(updater, { checkTimeoutMs: 25 });
    const status = await service.check();

    expect(status.phase).toBe("error");
    expect(status.errorMessage).toContain("No response from the update feed");
  });

  it("downloads with progress, then installs on request", async () => {
    const updater = new FakeUpdater();
    const { service, statuses } = createService(updater);

    await service.check();

    const downloading = service.download();
    const midDownload = service.getStatus();
    expect(midDownload.phase).toBe("downloading");
    expect(midDownload.progressPercent).toBe(0);

    await downloading;

    expect(updater.downloadCalls).toBe(1);
    expect(service.getStatus()).toMatchObject({ phase: "ready", progressPercent: 100 });
    expect(statuses.some((entry) => entry.phase === "downloading")).toBe(true);

    service.install();

    expect(updater.quitCalls).toEqual([{ isSilent: true, isForceRunAfter: true }]);
  });

  it("ignores downloads when no update is available", async () => {
    const updater = new FakeUpdater();
    updater.checkResult = { updateInfo: null };

    const { service } = createService(updater);
    await service.check();

    const status = await service.download();

    expect(updater.downloadCalls).toBe(0);
    expect(status.phase).toBe("up-to-date");
  });

  it("reports download failures", async () => {
    const updater = new FakeUpdater();
    updater.downloadError = new Error("disk full");

    const { service } = createService(updater);
    await service.check();

    await expect(service.download()).resolves.toMatchObject({
      phase: "error",
      errorMessage: "disk full"
    });
  });

  it("deduplicates concurrent checks", async () => {
    const updater = new FakeUpdater();
    const { service } = createService(updater);

    await Promise.all([service.check(), service.check()]);

    expect(updater.checkCalls).toBe(1);
  });

  it("can simulate an available update without touching the updater", async () => {
    const updater = new FakeUpdater();
    const { service } = createService(updater, { simulatedVersion: "9.9.9" });

    const status = await service.check();

    expect(updater.checkCalls).toBe(0);
    expect(status).toMatchObject({ phase: "available", latestVersion: "9.9.9" });
  });

  it("stops listening to the updater after dispose", async () => {
    const updater = new FakeUpdater();
    const { service, statuses } = createService(updater);

    service.dispose();
    statuses.length = 0;

    updater.emit("update-available", { version: "0.3.0" } satisfies UpdaterReleaseInfo);

    expect(statuses).toHaveLength(0);
  });

  it("does not check again once an update is ready to install", async () => {
    const updater = new FakeUpdater();
    const { service } = createService(updater);

    await service.check();
    await service.download();
    expect(service.getStatus().phase).toBe("ready");

    const checkSpy = vi.spyOn(updater, "checkForUpdates");
    await service.check();

    expect(checkSpy).not.toHaveBeenCalled();
    expect(service.getStatus().phase).toBe("ready");
  });
});
