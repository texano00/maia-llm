import { describe, expect, it } from "vitest";
import { createPortalCatalogueSource } from "../../src/main/services/catalogue/portal-source";

const snapshot = {
  snapshot: { version: 7, refreshedAt: "2026-11-14T10:00:00.000Z", modelCount: 3 },
  models: [
    {
      id: "huihui-ai/DeepSeek-R1-Distill-Qwen-32B-abliterated",
      author: "huihui-ai",
      name: "DeepSeek-R1-Distill-Qwen-32B-abliterated",
      downloads: 10,
      likes: 1,
      gated: "none",
      pipelineTag: "text-generation",
      capabilities: ["text", "reasoning"],
      artifacts: [{ path: "model-Q4_K_M.gguf", sizeBytes: 19_000_000_000, format: "gguf" }],
      engine: "llamacpp",
      supported: true,
      supportedReason: null,
      refreshedAt: "2026-11-14T10:00:00.000Z"
    },
    {
      id: "openai-community/gpt2",
      author: "openai-community",
      name: "gpt2",
      downloads: 21_000_000,
      likes: 2_000,
      gated: "none",
      pipelineTag: "text-generation",
      capabilities: ["text"],
      engine: "vllm",
      supported: false,
      supportedReason: "the model defines no chat template, so it cannot answer chat requests"
    }
  ]
};

function respond(body: unknown, init: { status?: number; etag?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.etag) {
    headers.set("etag", init.etag);
  }
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

describe("portal catalogue source", () => {
  it("returns the published rows with their verdicts", async () => {
    const source = createPortalCatalogueSource({
      portalUrl: "http://portal.test",
      fetchImpl: (async () => respond(snapshot, { etag: '"v7"' })) as unknown as typeof fetch
    });

    const models = await source.listResolved("", 100);

    expect(models).toHaveLength(2);
    expect(models?.[0]).toMatchObject({
      id: "huihui-ai/DeepSeek-R1-Distill-Qwen-32B-abliterated",
      supported: true,
      engine: "llamacpp"
    });
    expect(models?.[1]).toMatchObject({ supported: false });
  });

  it("filters by the search term the way the list expects", async () => {
    const source = createPortalCatalogueSource({
      portalUrl: "http://portal.test",
      fetchImpl: (async () => respond(snapshot)) as unknown as typeof fetch
    });

    const models = await source.listResolved("deepseek", 100);

    expect(models?.map((model) => model.id)).toEqual([
      "huihui-ai/DeepSeek-R1-Distill-Qwen-32B-abliterated"
    ]);
  });

  it("answers the detail questions from the same snapshot", async () => {
    const source = createPortalCatalogueSource({
      portalUrl: "http://portal.test",
      fetchImpl: (async () => respond(snapshot)) as unknown as typeof fetch
    });
    await source.listResolved("", 100);

    expect(source.getSupport("openai-community/gpt2")).toMatchObject({ supported: false });
    expect(source.getSupport("nobody/unknown")).toBeNull();
    expect(source.getArtifacts("huihui-ai/DeepSeek-R1-Distill-Qwen-32B-abliterated")).toHaveLength(1);
    expect(source.snapshotInfo()).toMatchObject({ version: 7, source: "portal" });
  });

  it("says 'nothing to say' when the portal has no snapshot yet", async () => {
    const source = createPortalCatalogueSource({
      portalUrl: "http://portal.test",
      fetchImpl: (async () => respond({ error: "no_snapshot" }, { status: 503 })) as unknown as typeof fetch,
      logger: { warn: () => undefined }
    });

    expect(await source.listResolved("", 100)).toBeNull();
  });

  it("reuses the snapshot when the ETag still matches", async () => {
    const calls: Array<string | null> = [];
    let version = 1;
    const source = createPortalCatalogueSource({
      portalUrl: "http://portal.test",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const headers = new Headers(init.headers as HeadersInit);
        calls.push(headers.get("if-none-match"));
        if (headers.get("if-none-match") === '"v1"') {
          return new Response(null, { status: 304 });
        }
        version += 1;
        return respond(snapshot, { etag: '"v1"' });
      }) as unknown as typeof fetch
    });

    await source.listResolved("", 100);
    const again = await source.listResolved("", 100);

    expect(calls).toEqual([null, '"v1"']);
    expect(again).toHaveLength(2);
    expect(version).toBe(2);
  });

  it("survives a broken portal and keeps the previous answer", async () => {
    let fail = false;
    const source = createPortalCatalogueSource({
      portalUrl: "http://portal.test",
      fetchImpl: (async () => {
        if (fail) {
          throw new Error("ECONNREFUSED");
        }
        return respond(snapshot, { etag: '"v1"' });
      }) as unknown as typeof fetch,
      logger: { warn: () => undefined }
    });

    const first = await source.listResolved("", 100);
    fail = true;
    const second = await source.listResolved("", 100);

    expect(second).toEqual(first);
  });
});
