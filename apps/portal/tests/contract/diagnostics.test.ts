import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { baseConfig } from "../../src/config";
import { buildServer } from "../../src/server";

describe("diagnostics ingestion", () => {
  let directory: string;
  let server: FastifyInstance;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "maia-diagnostics-"));
    server = await buildServer({
      config: baseConfig({
        databaseFile: join(directory, "maia.sqlite"),
        legacyReputationFile: null,
      }),
    });
  });

  afterEach(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("accepts a batch and keeps it for inspection", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/diagnostics/logs",
      payload: {
        app: "maia-llm",
        version: "0.1.4",
        platform: "win32",
        events: [
          { time: 1_700_000_000_000, level: "error", message: "Update check failed" },
          {
            time: 1_700_000_000_001,
            level: "info",
            message: "Application services initialized",
            context: { releaseChannel: "stable" },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: 2 });

    const listed = await server.inject({ method: "GET", url: "/v1/diagnostics/logs" });
    const body = listed.json() as {
      batches: Array<{
        app: string;
        version: string;
        platform: string;
        events: Array<{ level: string; message: string; context: unknown }>;
      }>;
    };

    expect(body.batches).toHaveLength(1);
    expect(body.batches[0]).toMatchObject({
      app: "maia-llm",
      version: "0.1.4",
      platform: "win32",
    });
    expect(body.batches[0]!.events).toHaveLength(2);
    expect(body.batches[0]!.events[1]).toMatchObject({
      level: "info",
      message: "Application services initialized",
      context: { releaseChannel: "stable" },
    });
  });

  it("filters by level and reports ingested volume", async () => {
    await server.inject({
      method: "POST",
      url: "/v1/diagnostics/logs",
      payload: {
        app: "maia-llm",
        version: "0.6.1",
        platform: "linux",
        events: [
          { time: 1_700_000_000_000, level: "error", message: "boom" },
          { time: 1_700_000_000_001, level: "info", message: "fine" },
        ],
      },
    });

    const errors = await server.inject({ method: "GET", url: "/v1/diagnostics/logs?level=error" });
    const batch = (errors.json() as { batches: Array<{ events: Array<{ message: string }> }> })
      .batches[0];

    expect(batch?.events.map((event) => event.message)).toEqual(["boom"]);

    const stats = await server.inject({ method: "GET", url: "/v1/diagnostics/stats" });
    expect(stats.json()).toMatchObject({ events: 2 });
  });

  it("rejects payloads that are not diagnostic batches", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/diagnostics/logs",
      payload: { app: "maia-llm", version: "0.1.4", platform: "win32", events: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_payload" });
  });

  it("still answers the health probe", async () => {
    const response = await server.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", storage: "sqlite" });
  });
});
