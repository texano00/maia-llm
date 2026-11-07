import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseConfig } from "../../src/config.js";
import { createAppContext, type AppContext } from "../../src/context.js";
import { buildServer } from "../../src/server.js";
import type { CatalogueClient } from "../../src/services/catalogue/huggingface.js";
import { SnapshotService } from "../../src/services/catalogue/snapshot-service.js";

const client: CatalogueClient = {
  async listModels() {
    return [
      {
        id: "Qwen/Qwen2.5-7B-Instruct",
        pipeline_tag: "text-generation",
        siblings: [
          { rfilename: "config.json", size: 1 },
          { rfilename: "model.safetensors", size: 1_000 }
        ]
      }
    ];
  },
  async getFiles() {
    return [
      { rfilename: "config.json", size: 1 },
      { rfilename: "model.safetensors", size: 1_000 }
    ];
  },
  async hasChatTemplate() {
    return true;
  }
};

describe("configs API", () => {
  let directory: string;
  let context: AppContext;
  let server: Awaited<ReturnType<typeof buildServer>> | null;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "maia-config-"));
    context = await createAppContext({
      config: baseConfig({
        databaseFile: join(directory, "maia.sqlite"),
        legacyReputationFile: null,
        portalTokenSecret: "config-test-secret",
        requireClientAuth: true
      })
    });
    context.snapshot = new SnapshotService({ db: context.db, client });
    server = null;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    await context.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function start() {
    server = await buildServer({ context });
    return server;
  }

  it("requires an installation credential", async () => {
    const app = await start();
    const response = await app.inject({ method: "GET", url: "/v1/config/catalogue" });

    expect(response.statusCode).toBe(401);
  });

  it("answers 503 before the first snapshot is published", async () => {
    const app = await start();
    const enrolled = await app.inject({
      method: "POST",
      url: "/v1/installations",
      payload: { installId: "install-config-1" }
    });
    const { accessToken } = enrolled.json() as { accessToken: string };

    const response = await app.inject({
      method: "GET",
      url: "/v1/config/catalogue",
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "no_snapshot", retryable: true });
  });

  it("serves the snapshot with an ETag and honours If-None-Match", async () => {
    await context.snapshot.refresh("manual");
    const app = await start();
    const enrolled = await app.inject({
      method: "POST",
      url: "/v1/installations",
      payload: { installId: "install-config-2" }
    });
    const { accessToken } = enrolled.json() as { accessToken: string };

    const first = await app.inject({
      method: "GET",
      url: "/v1/config/catalogue",
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(first.statusCode).toBe(200);
    const etag = String(first.headers["etag"]);
    expect(etag).toBe('"snap-1"');

    const body = first.json() as {
      snapshot: { version: number; supportedCount: number };
      models: Array<{ id: string; supported: boolean; engine: string }>;
    };
    expect(body.snapshot.version).toBe(1);
    expect(body.snapshot.supportedCount).toBe(1);
    expect(body.models[0]).toMatchObject({
      id: "Qwen/Qwen2.5-7B-Instruct",
      supported: true,
      engine: "vllm"
    });

    const cached = await app.inject({
      method: "GET",
      url: "/v1/config/catalogue",
      headers: { authorization: `Bearer ${accessToken}`, "if-none-match": etag }
    });
    expect(cached.statusCode).toBe(304);
  });

  it("serves the use cases list", async () => {
    const app = await start();
    const enrolled = await app.inject({
      method: "POST",
      url: "/v1/installations",
      payload: { installId: "install-config-3" }
    });
    const { accessToken } = enrolled.json() as { accessToken: string };

    const response = await app.inject({
      method: "GET",
      url: "/v1/config/use-cases",
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ useCases: [] });
  });
});
