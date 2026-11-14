import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DIAGNOSTICS_URL,
  DEFAULT_GPU_FILTERS,
  DEFAULT_GPU_STARTUP_RETRIES
} from "@maia/contracts";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { SettingsStore } from "../../src/main/services/settings/store";
import { seedAccount } from "../helpers/accounts";

describe("SettingsStore", () => {
  let db: DatabaseConnection;
  let store: SettingsStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedAccount(db);
    store = new SettingsStore(db, "account-test");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("returns the documented defaults before anything is saved", () => {
    expect(store.get()).toEqual({
      diagnosticsUrl: DEFAULT_DIAGNOSTICS_URL,
      gpuFilters: DEFAULT_GPU_FILTERS,
      gpuStartupRetries: DEFAULT_GPU_STARTUP_RETRIES,
      usageReporting: false,
      walletWarnThresholdMicroUsd: 2_000_000,
      onboardingCompleted: false,
      onboardingDismissedAt: null,
      dismissedNotificationKeys: [],
      installationId: null
    });
    expect(DEFAULT_DIAGNOSTICS_URL).toBe("https://api.maiallm.com");
    expect(DEFAULT_GPU_FILTERS).toEqual({
      countries: [],
      datacenters: [],
      minReliability: null,
      maxHourlyMicroUsd: null,
      // Startup gates are on by default; a host slower than this turns a two
      // minute boot into a ten minute one.
      minDownloadMbps: 1000,
      minUploadMbps: 200,
      minDiskBandwidthMBps: 500
    });
  });

  it("moves an install that still holds the old localhost default", () => {
    db.prepare(
      "INSERT INTO preferences (key, value_json, updated_at) VALUES (?, ?, ?)"
    ).run(
      "app_settings",
      JSON.stringify({
        diagnosticsUrl: "http://localhost:8787",
        gpuFilters: DEFAULT_GPU_FILTERS,
        gpuStartupRetries: DEFAULT_GPU_STARTUP_RETRIES,
      }),
      "2026-11-03T00:00:00.000Z"
    );

    expect(store.get().diagnosticsUrl).toBe(DEFAULT_DIAGNOSTICS_URL);
  });

  it("keeps a diagnostics host the user chose", () => {
    store.update({ diagnosticsUrl: "http://localhost:9000" });

    expect(store.get().diagnosticsUrl).toBe("http://localhost:9000");
  });

  it("persists a new diagnostics host", () => {
    const saved = store.update({ diagnosticsUrl: "http://192.168.1.20:9000" });

    expect(saved.diagnosticsUrl).toBe("http://192.168.1.20:9000");
    expect(store.get().diagnosticsUrl).toBe("http://192.168.1.20:9000");
  });

  it("keeps the stored value when a patch omits fields", () => {
    store.update({ diagnosticsUrl: "https://logs.example.dev" });

    expect(store.update({}).diagnosticsUrl).toBe("https://logs.example.dev");
  });

  it("rejects values that are not http URLs", () => {
    expect(() => store.update({ diagnosticsUrl: "localhost:8787" })).toThrowError();
    expect(store.get().diagnosticsUrl).toBe(DEFAULT_DIAGNOSTICS_URL);
  });

  it("falls back to defaults when the stored row is not valid settings", () => {
    db.prepare(
      "INSERT INTO preferences (key, value_json, updated_at) VALUES (?, ?, ?)"
    ).run("app_settings", JSON.stringify({ diagnosticsUrl: "not a url" }), "2026-11-03T00:00:00.000Z");

    expect(store.get()).toEqual({
      diagnosticsUrl: DEFAULT_DIAGNOSTICS_URL,
      gpuFilters: DEFAULT_GPU_FILTERS,
      gpuStartupRetries: DEFAULT_GPU_STARTUP_RETRIES,
      usageReporting: false,
      walletWarnThresholdMicroUsd: 2_000_000,
      onboardingCompleted: false,
      onboardingDismissedAt: null,
      dismissedNotificationKeys: [],
      installationId: null
    });
  });

  it("survives a corrupted row", () => {
    db.prepare(
      "INSERT INTO preferences (key, value_json, updated_at) VALUES (?, ?, ?)"
    ).run("app_settings", "{not json", "2026-11-03T00:00:00.000Z");

    expect(store.get()).toEqual({
      diagnosticsUrl: DEFAULT_DIAGNOSTICS_URL,
      gpuFilters: DEFAULT_GPU_FILTERS,
      gpuStartupRetries: DEFAULT_GPU_STARTUP_RETRIES,
      usageReporting: false,
      walletWarnThresholdMicroUsd: 2_000_000,
      onboardingCompleted: false,
      onboardingDismissedAt: null,
      dismissedNotificationKeys: [],
      installationId: null
    });
  });

  it("uses the default retry count for settings saved before the option existed", () => {
    db.prepare(
      "INSERT INTO preferences (key, value_json, updated_at) VALUES (?, ?, ?)"
    ).run(
      "app_settings",
      JSON.stringify({
        diagnosticsUrl: DEFAULT_DIAGNOSTICS_URL,
        gpuFilters: DEFAULT_GPU_FILTERS
      }),
      "2026-11-03T00:00:00.000Z"
    );

    expect(store.get().gpuStartupRetries).toBe(DEFAULT_GPU_STARTUP_RETRIES);
  });

  it("persists the configured GPU startup retry count", () => {
    expect(store.update({ gpuStartupRetries: 2 }).gpuStartupRetries).toBe(2);
    expect(store.get().gpuStartupRetries).toBe(2);
    expect(() => store.update({ gpuStartupRetries: 11 })).toThrowError();
  });
});
