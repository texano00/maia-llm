import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../src/server";
import { baseConfig, loadConfig } from "../../src/config";

describe("telemetry API health", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "maia-server-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns an ok status and reports the storage engine", async () => {
    const app = await buildServer({
      config: baseConfig({
        databaseFile: join(directory, "maia.sqlite"),
        legacyReputationFile: null,
      }),
    });

    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok", storage: "sqlite" });
    } finally {
      await app.close();
    }
  });

  it("creates the database file on first boot", async () => {
    const app = await buildServer({
      config: baseConfig({
        databaseFile: join(directory, "nested", "maia.sqlite"),
        legacyReputationFile: null,
      }),
    });

    try {
      expect((await app.inject({ method: "GET", url: "/v1/gpus" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("configuration", () => {
  it("defaults to a SQLite file in the working directory", () => {
    const config = loadConfig({});

    expect(config.databaseDriver).toBe("sqlite");
    expect(config.databaseFile.endsWith("var/maia.sqlite")).toBe(true);
    expect(config.unstableTtlMs).toBe(6 * 60 * 60_000);
    expect(config.telemetryRetentionMs).toBe(30 * 24 * 60 * 60_000);
    expect(config.legacyReputationFile).toBeNull();
  });

  it("reads overrides from the environment", () => {
    const config = loadConfig({
      MAIA_DATABASE_FILE: "/data/maia.sqlite",
      MAIA_UNSTABLE_TTL_HOURS: "12",
      MAIA_TELEMETRY_RETENTION_DAYS: "7",
      MAIA_REPUTATION_FILE: "/data/legacy.json",
    });

    expect(config).toMatchObject({
      databaseFile: "/data/maia.sqlite",
      unstableTtlMs: 12 * 60 * 60_000,
      telemetryRetentionMs: 7 * 24 * 60 * 60_000,
      legacyReputationFile: "/data/legacy.json",
    });
  });

  it("explains what to do when another driver is requested", () => {
    expect(() => loadConfig({ MAIA_DB_DRIVER: "postgres" })).toThrow(/add an adapter/);
    expect(() => loadConfig({ MAIA_DB_DRIVER: "oracle" })).toThrow(/Unsupported MAIA_DB_DRIVER/);
  });
});
