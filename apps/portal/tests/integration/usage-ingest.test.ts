import { describe, expect, it } from "vitest";
import { baseConfig } from "../../src/config.js";
import { createAppContext } from "../../src/context.js";
import { buildServer } from "../../src/server.js";

const SAMPLE = {
  installationId: "22222222-2222-4222-8222-222222222222",
  appVersion: "0.8.4",
  os: "windows",
  osVersion: "11",
  arch: "x64",
  deviceClass: "desktop",
  modelId: "Qwen/Qwen2.5-7B-Instruct",
  capability: "text",
  outputTokens: 300,
  generationMs: 6_000,
  tokensPerSecond: 50,
  outcome: "completed",
  occurredAt: "2026-11-11T10:00:00.000Z"
};

function config() {
  return baseConfig({ databaseFile: ":memory:", requireClientAuth: false, usageEnabled: true });
}

describe("usage ingestion", () => {
  it("stores the allowlisted sample with the observed address", async () => {
    const context = await createAppContext({ config: config() });
    try {
      await context.usage.ingest(SAMPLE, "203.0.113.9");
      const rows = await context.db.query<{
        installation_id: string;
        tokens_per_second: number;
        observed_address: string;
      }>("SELECT installation_id, tokens_per_second, observed_address FROM usage_samples");

      expect(rows).toEqual([
        {
          installation_id: SAMPLE.installationId,
          tokens_per_second: 50,
          observed_address: "203.0.113.9"
        }
      ]);
    } finally {
      await context.close();
    }
  });

  it("refuses unknown content keys without storing anything", async () => {
    const context = await createAppContext({ config: config() });
    try {
      await expect(
        context.usage.ingest({ ...SAMPLE, prompt: "secret" }, "203.0.113.9")
      ).rejects.toMatchObject({ status: 400, code: "VALIDATION_FAILED" });
      expect(await context.repositories.usage.countSamples()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("refuses an opted-out installation", async () => {
    const context = await createAppContext({ config: config() });
    try {
      await context.usage.setPreference(
        { installationId: SAMPLE.installationId, occurredAt: "2026-11-11T09:00:00.000Z" },
        true
      );
      await expect(context.usage.ingest(SAMPLE, "203.0.113.9")).rejects.toMatchObject({
        status: 403,
        code: "USAGE_OPTED_OUT"
      });
      expect(await context.repositories.usage.countSamples()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("accepts the sample over HTTP and reports the status codes", async () => {
    const app = await buildServer({ config: config() });
    try {
      const accepted = await app.inject({ method: "POST", url: "/api/v0/usage", payload: SAMPLE });
      expect(accepted.statusCode).toBe(202);

      const invalid = await app.inject({
        method: "POST",
        url: "/api/v0/usage",
        payload: { ...SAMPLE, prompt: "secret" }
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: "VALIDATION_FAILED" });

      const optOut = await app.inject({
        method: "POST",
        url: "/api/v0/usage/opt-out",
        payload: { installationId: SAMPLE.installationId, occurredAt: "2026-11-11T11:00:00.000Z" }
      });
      expect(optOut.statusCode).toBe(202);

      const blocked = await app.inject({ method: "POST", url: "/api/v0/usage", payload: SAMPLE });
      expect(blocked.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
