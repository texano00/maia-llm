import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/server";

describe("diagnostics ingestion", () => {
  const server = buildServer();

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
            context: { releaseChannel: "stable" }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: 2 });

    const listed = await server.inject({ method: "GET", url: "/v1/diagnostics/logs" });
    const body = listed.json() as { events: Array<{ events: unknown[] }> };
    const last = body.events.at(-1);

    expect(last?.events).toHaveLength(2);
  });

  it("rejects payloads that are not diagnostic batches", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/diagnostics/logs",
      payload: { app: "maia-llm", version: "0.1.4", platform: "win32", events: [] }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_payload" });
  });

  it("still answers the health probe", async () => {
    const response = await server.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
