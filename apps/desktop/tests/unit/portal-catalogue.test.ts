import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { CatalogueRepository } from "../../src/main/services/catalogue/repository";
import { CatalogueService } from "../../src/main/services/catalogue/service";
import { createPortalCatalogueSource } from "../../src/main/services/catalogue/portal-source";
import { createPortalClient, PortalError, type PortalCatalogueModel } from "../../src/main/services/portal/client";
import { PortalCredentialStore } from "../../src/main/services/portal/credentials";
import { assertChatRunnable } from "../../src/main/services/catalogue/runnable";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "maia-portal-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function memoryDatabase(): DatabaseConnection {
  const database = openDatabase(":memory:");
  cleanups.push(() => closeDatabase(database));
  return database;
}

const SNAPSHOT_MODEL: PortalCatalogueModel = {
  id: "Qwen/Qwen3-14B",
  author: "Qwen",
  name: "Qwen3-14B",
  license: "apache-2.0",
  pipelineTag: "text-generation",
  parameterCount: 14_000_000_000,
  contextWindow: 131_072,
  downloads: 1200,
  likes: 42,
  gated: "none",
  lastModifiedAt: "2026-10-01T00:00:00.000Z",
  tags: ["text-generation", "tools"],
  capabilities: ["chat", "tools"],
  artifacts: [
    { path: "model-00001-of-00002.safetensors", sizeBytes: 4_000, format: "safetensors", quantization: null, sha256: "a".repeat(64) }
  ],
  engine: "vllm",
  supported: true,
  supportedReason: null,
  refreshedAt: "2026-11-07T10:00:00.000Z"
};

const UNSUPPORTED_MODEL: PortalCatalogueModel = {
  ...SNAPSHOT_MODEL,
  id: "openai-community/gpt2",
  author: "openai-community",
  name: "gpt2",
  pipelineTag: "text-generation",
  downloads: 900,
  likes: 10,
  capabilities: ["chat"],
  engine: "vllm",
  supported: false,
  supportedReason: "the model defines no chat template, so it cannot answer chat requests"
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** Records calls and answers from a script keyed by `METHOD path`. */
function fakeFetch(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { url, method, headers };
    calls.push(call);

    const route = routes[`${method} ${path}`];
    if (!route) {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }

    return route(call);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const issued = {
  installationId: "installation-1",
  accessToken: "access-1",
  accessExpiresAt: "2026-11-07T11:00:00.000Z",
  refreshToken: "refresh-1",
  refreshExpiresAt: "2026-12-07T11:00:00.000Z"
};

async function portalClient(routes: Record<string, (call: Call) => Response | Promise<Response>>, now = "2026-11-07T10:30:00.000Z") {
  const directory = await temporaryDirectory();
  const credentials = new PortalCredentialStore(join(directory, "portal.json"));
  const fake = fakeFetch(routes);
  const client = createPortalClient({
    baseUrl: () => "https://portal.test",
    credentials,
    appVersion: "0.8.0",
    platform: "linux",
    fetchImpl: fake.fetchImpl,
    now: () => new Date(now)
  });

  return { client, credentials, calls: fake.calls };
}

describe("portal credentials", () => {
  it("mints and keeps one installation id across reloads", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "portal.json");

    const first = await new PortalCredentialStore(file).installId();
    const second = await new PortalCredentialStore(file).load();

    expect(first.length).toBeGreaterThan(7);
    expect(second.installId).toBe(first);
    expect(second.accessToken).toBeNull();
    expect(JSON.parse(await readFile(file, "utf8")).installId).toBe(first);
  });
});

describe("portal client", () => {
  it("enrolls on first use and sends the access token", async () => {
    const { client, calls } = await portalClient({
      "POST /v1/installations": () => Response.json(issued, { status: 201 }),
      "GET /v1/config/catalogue": () =>
        Response.json(
          { snapshot: { version: 3, refreshedAt: "2026-11-07T10:00:00.000Z", modelCount: 1, supportedCount: 1 }, models: [SNAPSHOT_MODEL] },
          { headers: { etag: '"snap-3"' } }
        )
    });

    const catalogue = await client.catalogue();

    expect(catalogue.snapshot.version).toBe(3);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[1]?.headers.authorization).toBe("Bearer access-1");
  });

  it("serves the cached body on 304 and reuses the etag", async () => {
    let catalogueCalls = 0;
    const { client, calls } = await portalClient({
      "POST /v1/installations": () => Response.json(issued, { status: 201 }),
      "GET /v1/config/catalogue": (call) => {
        catalogueCalls += 1;
        return call.headers["if-none-match"] === '"snap-3"'
          ? new Response(null, { status: 304 })
          : Response.json(
              { snapshot: { version: 3, refreshedAt: "2026-11-07T10:00:00.000Z", modelCount: 1, supportedCount: 1 }, models: [SNAPSHOT_MODEL] },
              { headers: { etag: '"snap-3"' } }
            );
      }
    });

    const first = await client.catalogue();
    const second = await client.catalogue();

    expect(catalogueCalls).toBe(2);
    expect(second).toEqual(first);
    expect(calls.at(-1)?.headers["if-none-match"]).toBe('"snap-3"');
  });

  it("refreshes once when the access token is rejected", async () => {
    let catalogueCalls = 0;
    const { client } = await portalClient({
      "POST /v1/installations": () => Response.json(issued, { status: 201 }),
      "POST /v1/installations/refresh": () =>
        Response.json({ ...issued, accessToken: "access-2" }, { status: 200 }),
      "GET /v1/config/catalogue": (call) => {
        catalogueCalls += 1;
        return call.headers.authorization === "Bearer access-2"
          ? Response.json({
              snapshot: { version: 1, refreshedAt: "2026-11-07T10:00:00.000Z", modelCount: 1, supportedCount: 1 },
              models: [SNAPSHOT_MODEL]
            })
          : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
    });

    const catalogue = await client.catalogue();

    expect(catalogue.snapshot.version).toBe(1);
    expect(catalogueCalls).toBe(2);
  });

  it("reports a missing snapshot distinctly from an outage", async () => {
    const { client } = await portalClient({
      "POST /v1/installations": () => Response.json(issued, { status: 201 }),
      "GET /v1/config/catalogue": () => new Response(JSON.stringify({ error: "no_snapshot" }), { status: 503 })
    });

    await expect(client.catalogue()).rejects.toMatchObject({ code: "no_snapshot" });
    await expect(client.catalogue()).rejects.toBeInstanceOf(PortalError);
  });
});

describe("portal-backed catalogue", () => {
  async function catalogueService(models: PortalCatalogueModel[]) {
    const { client } = await portalClient({
      "POST /v1/installations": () => Response.json(issued, { status: 201 }),
      "GET /v1/config/catalogue": () =>
        Response.json({
          snapshot: { version: 7, refreshedAt: "2026-11-07T10:00:00.000Z", modelCount: models.length, supportedCount: 1 },
          models
        })
    });

    return new CatalogueService({
      repository: new CatalogueRepository(memoryDatabase()),
      source: createPortalCatalogueSource({ client }),
      now: () => new Date("2026-11-07T10:30:00.000Z")
    });
  }

  it("carries the backend verdict and snapshot age into the list", async () => {
    const service = await catalogueService([SNAPSHOT_MODEL, UNSUPPORTED_MODEL]);

    const result = await service.search({});

    expect(result.snapshot).toEqual({
      version: 7,
      refreshedAt: "2026-11-07T10:00:00.000Z",
      source: "portal"
    });
    const supported = result.models.find((model) => model.id === "Qwen/Qwen3-14B");
    const unsupported = result.models.find((model) => model.id === "openai-community/gpt2");
    expect(supported?.supported).toBe(true);
    expect(supported?.engine).toBe("vllm");
    expect(unsupported?.supported).toBe(false);
    expect(unsupported?.supportedReason).toContain("no chat template");
    // Snapshot facts survive the round trip through the Hub-shaped mapper.
    expect(supported?.parameterCount).toBe(14_000_000_000);
    expect(supported?.contextWindow).toBe(131_072);
    expect(supported?.license).toBe("apache-2.0");
  });

  it("hides unsupported models when asked, and keeps them otherwise", async () => {
    const service = await catalogueService([SNAPSHOT_MODEL, UNSUPPORTED_MODEL]);

    const all = await service.search({});
    const filtered = await service.search({ supportedOnly: true });

    expect(all.models).toHaveLength(2);
    expect(filtered.models.map((model) => model.id)).toEqual(["Qwen/Qwen3-14B"]);
  });

  it("refuses a start with the backend's reason and keeps snapshot artifacts", async () => {
    const service = await catalogueService([SNAPSHOT_MODEL, UNSUPPORTED_MODEL]);

    await expect(assertChatRunnable(service, "openai-community/gpt2")).rejects.toThrow(/chat template/);
    await expect(assertChatRunnable(service, "Qwen/Qwen3-14B")).resolves.toBeUndefined();

    const detail = await service.detail("Qwen/Qwen3-14B");
    expect(detail.support).toEqual({ supported: true, engine: "vllm", reason: null });
    expect(detail.artifacts).toHaveLength(1);
    expect(detail.artifacts[0]?.path).toBe("model-00001-of-00002.safetensors");
    expect(detail.runnable).toBe(true);
  });
});
