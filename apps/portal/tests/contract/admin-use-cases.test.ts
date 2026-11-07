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
      },
      {
        id: "openai-community/gpt2",
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
  async hasChatTemplate(modelId) {
    return modelId !== "openai-community/gpt2";
  }
};

describe("backoffice use cases", () => {
  let directory: string;
  let context: AppContext;
  let server: Awaited<ReturnType<typeof buildServer>>;
  let cookie: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "maia-admin-"));
    context = await createAppContext({
      config: baseConfig({
        databaseFile: join(directory, "maia.sqlite"),
        legacyReputationFile: null,
        portalTokenSecret: "admin-test-secret",
        requireClientAuth: false,
        adminEmail: "admin@maia.test",
        adminPassword: "correct horse"
      })
    });
    context.snapshot = new SnapshotService({ db: context.db, client });
    await context.snapshot.refresh("manual");

    server = await buildServer({ context });
    const signIn = await server.inject({
      method: "POST",
      url: "/v1/admin/session",
      payload: { email: "admin@maia.test", password: "correct horse" }
    });
    cookie = String(signIn.headers["set-cookie"]).split(";")[0] ?? "";
  });

  afterEach(async () => {
    await server.close();
    await context.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires an administrator session", async () => {
    const response = await server.inject({ method: "GET", url: "/v1/admin/use-cases" });
    expect(response.statusCode).toBe(401);
  });

  it("creates a use case and reports unsupported entries instead of hiding them", async () => {
    const created = await server.inject({
      method: "POST",
      url: "/v1/admin/use-cases",
      headers: { cookie },
      payload: {
        title: "I want to do some coding",
        description: "Pick a capable chat model and start writing code with it.",
        models: ["Qwen/Qwen2.5-7B-Instruct", "openai-community/gpt2"]
      }
    });

    expect(created.statusCode).toBe(201);
    const view = created.json() as {
      id: string;
      version: number;
      models: Array<{ id: string; supported: boolean; missing: boolean }>;
    };
    expect(view.version).toBe(1);
    expect(view.models).toEqual([
      { id: "Qwen/Qwen2.5-7B-Instruct", supported: true, engine: "vllm", missing: false },
      { id: "openai-community/gpt2", supported: false, engine: "vllm", missing: false }
    ]);

    const listed = await server.inject({
      method: "GET",
      url: "/v1/admin/use-cases",
      headers: { cookie }
    });
    expect((listed.json() as { useCases: unknown[] }).useCases).toHaveLength(1);
  });

  it("rejects a model that is not in the snapshot", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/admin/use-cases",
      headers: { cookie },
      payload: {
        title: "Unknown model",
        description: "This description is long enough to pass validation.",
        models: ["someone/does-not-exist"]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "validation" });
    expect((response.json() as { message: string }).message).toContain("someone/does-not-exist");
  });

  it("refuses a stale update and accepts the current version", async () => {
    const created = await server.inject({
      method: "POST",
      url: "/v1/admin/use-cases",
      headers: { cookie },
      payload: {
        title: "Security lab",
        description: "Run a cybersecurity laboratory on a private model.",
        models: ["Qwen/Qwen2.5-7B-Instruct"]
      }
    });
    const { id } = created.json() as { id: string };

    const payload = {
      title: "Security laboratory",
      description: "Run a cybersecurity laboratory on a private model.",
      models: ["Qwen/Qwen2.5-7B-Instruct"],
      version: 9
    };

    const stale = await server.inject({
      method: "PUT",
      url: `/v1/admin/use-cases/${id}`,
      headers: { cookie },
      payload
    });
    expect(stale.statusCode).toBe(409);

    const fresh = await server.inject({
      method: "PUT",
      url: `/v1/admin/use-cases/${id}`,
      headers: { cookie },
      payload: { ...payload, version: 1 }
    });
    expect(fresh.statusCode).toBe(200);
    expect((fresh.json() as { version: number }).version).toBe(2);
  });

  it("reorders use cases and serves the order to clients", async () => {
    const first = await server.inject({
      method: "POST",
      url: "/v1/admin/use-cases",
      headers: { cookie },
      payload: {
        title: "I want to do some coding",
        description: "Start coding with a capable chat model.",
        models: ["Qwen/Qwen2.5-7B-Instruct"]
      }
    });
    const second = await server.inject({
      method: "POST",
      url: "/v1/admin/use-cases",
      headers: { cookie },
      payload: {
        title: "Cybersecurity laboratory",
        description: "Run a security lab against a private model.",
        models: ["Qwen/Qwen2.5-7B-Instruct"]
      }
    });
    const firstId = (first.json() as { id: string }).id;
    const secondId = (second.json() as { id: string }).id;

    const reordered = await server.inject({
      method: "PUT",
      url: "/v1/admin/use-cases/order",
      headers: { cookie },
      payload: { ids: [secondId, firstId] }
    });
    expect(reordered.statusCode).toBe(200);

    const clientView = await server.inject({ method: "GET", url: "/v1/config/use-cases" });
    const { useCases } = clientView.json() as { useCases: Array<{ title: string }> };
    expect(useCases.map((useCase) => useCase.title)).toEqual([
      "Cybersecurity laboratory",
      "I want to do some coding"
    ]);
  });

  it("deletes a use case", async () => {
    const created = await server.inject({
      method: "POST",
      url: "/v1/admin/use-cases",
      headers: { cookie },
      payload: {
        title: "Temporary",
        description: "This one is created only to be deleted again.",
        models: ["Qwen/Qwen2.5-7B-Instruct"]
      }
    });
    const { id } = created.json() as { id: string };

    const removed = await server.inject({
      method: "DELETE",
      url: `/v1/admin/use-cases/${id}`,
      headers: { cookie }
    });
    expect(removed.statusCode).toBe(204);

    const listed = await server.inject({
      method: "GET",
      url: "/v1/admin/use-cases",
      headers: { cookie }
    });
    expect((listed.json() as { useCases: unknown[] }).useCases).toHaveLength(0);
  });

  it("stores a validated use-case image and serves it publicly", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

    const uploaded = await server.inject({
      method: "POST",
      url: "/v1/admin/assets",
      headers: { cookie },
      payload: { contentType: "image/png", base64: png }
    });
    expect(uploaded.statusCode).toBe(200);
    const { url } = uploaded.json() as { url: string };

    const fetched = await server.inject({ method: "GET", url });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers["content-type"]).toContain("image/png");

    const rejected = await server.inject({
      method: "POST",
      url: "/v1/admin/assets",
      headers: { cookie },
      payload: { contentType: "image/gif", base64: png }
    });
    expect(rejected.statusCode).toBe(400);
  });

  it("forces a refresh and records the run", async () => {
    const refreshed = await server.inject({
      method: "POST",
      url: "/v1/admin/catalogue/refresh",
      headers: { cookie }
    });
    expect(refreshed.statusCode).toBe(202);

    const status = await server.inject({
      method: "GET",
      url: "/v1/admin/catalogue",
      headers: { cookie }
    });
    const body = status.json() as {
      snapshot: { version: number } | null;
      runs: Array<{ outcome: string }>;
    };
    expect(body.snapshot?.version).toBe(2);
    expect(body.runs[0]?.outcome).toBe("success");
  });

  it("records administrative actions in the audit trail", async () => {
    await server.inject({
      method: "POST",
      url: "/v1/admin/use-cases",
      headers: { cookie },
      payload: {
        title: "Audited",
        description: "Creating this use case must leave an audit entry.",
        models: ["Qwen/Qwen2.5-7B-Instruct"]
      }
    });

    const audit = await server.inject({ method: "GET", url: "/v1/admin/audit", headers: { cookie } });
    const { entries } = audit.json() as { entries: Array<{ action: string }> };
    const actions = entries.map((entry) => entry.action);

    expect(actions).toContain("admin_signed_in");
    expect(actions).toContain("use_case_created");
  });
});
