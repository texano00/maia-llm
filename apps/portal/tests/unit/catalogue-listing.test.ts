import { describe, expect, it } from "vitest";
import { createHuggingFaceCatalogueClient } from "../../src/services/catalogue/huggingface.js";
import { mapCatalogModel } from "../../src/services/catalogue/model.js";

/**
 * The repository this was written for: a community abliterated quant that was
 * invisible in the catalogue. Two properties of it mattered:
 *
 * - the Hub tags it `image-text-to-text` (it ships an `mmproj`), so a listing
 *   filtered to `text-generation` could never return it;
 * - its quantizations sit at the repository root with no `tokenizer_config.json`,
 *   so the chat template has to come from the base repository.
 */
const ID = "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF";
const BASE = "huihui-ai/Huihui-Qwen3.8-27B-abliterated";

const record = {
  id: ID,
  pipeline_tag: "image-text-to-text",
  downloads: 4_094_475,
  likes: 2_123,
  gated: false,
  library_name: "transformers",
  tags: ["gguf", "abliterated", "qwen3"],
  siblings: [
    { rfilename: "README.md" },
    { rfilename: "Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf", lfs: { size: 17_000_000_000 } },
    { rfilename: "Huihui-Qwen3.8-27B-abliterated-Q8_0.gguf", lfs: { size: 29_000_000_000 } },
    { rfilename: "mmproj-model-bf16.gguf", lfs: { size: 900_000_000 } }
  ]
};

interface Call {
  url: string;
}

/** Serves the Hub's two listing sorts and the raw files, recording each call. */
function fakeFetch(calls: Call[]): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    calls.push({ url });

    if (url.includes("/api/models?") && url.includes(`filter=image-text-to-text`)) {
      return json([record]);
    }
    if (url.includes("/api/models?")) {
      // The plain text-generation ranking, which never held this repository.
      return json([{ id: "Qwen/Qwen2.5-7B-Instruct", pipeline_tag: "text-generation" }]);
    }
    if (url.startsWith(`https://huggingface.co/api/models/${ID}?blobs=true`)) {
      return json(record);
    }
    if (url.includes(`${ID}/raw/main/`)) {
      // No tokenizer metadata in a bare GGUF mirror.
      return new Response("not found", { status: 404 });
    }
    if (url === `https://huggingface.co/${BASE}/raw/main/chat_template.jinja`) {
      return new Response("{% for m in messages %}{{ m.content }}{% endfor %}");
    }
    if (url.includes(`${BASE}/raw/main/`)) {
      return new Response("not found", { status: 404 });
    }

    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("catalogue listing coverage", () => {
  it("asks for every chat-capable pipeline tag, by popularity and by recency", async () => {
    const calls: Call[] = [];
    const client = createHuggingFaceCatalogueClient({
      token: null,
      fetchImpl: fakeFetch(calls)
    });

    await client.listModels(300);

    const filters = calls
      .map((call) => new URL(call.url).searchParams)
      .filter((params) => params.has("filter"))
      .map((params) => `${params.get("filter")}|${params.get("sort")}`)
      .sort();

    expect(filters).toEqual([
      "image-text-to-text|downloads",
      "image-text-to-text|lastModified",
      "text-generation|downloads",
      "text-generation|lastModified"
    ]);
  });

  it("returns the repository once, even when both listings carry it", async () => {
    const calls: Call[] = [];
    const client = createHuggingFaceCatalogueClient({
      token: null,
      fetchImpl: fakeFetch(calls)
    });

    const models = await client.listModels(300);
    const matching = models.filter((entry) => entry.id === ID);

    expect(matching).toHaveLength(1);
  });

  it("judges the model supported, taking the chat template from its base repository", async () => {
    const calls: Call[] = [];
    const client = createHuggingFaceCatalogueClient({
      token: null,
      fetchImpl: fakeFetch(calls)
    });

    const files = await client.getFiles(ID);
    const chatTemplate = await client.hasChatTemplate(ID);

    const model = mapCatalogModel({
      payload: { ...record, siblings: files },
      refreshedAt: "2026-11-14T10:00:00.000Z",
      chatTemplate
    });

    expect(chatTemplate).toBe(true);
    expect(model.engine).toBe("llamacpp");
    expect(model.supported).toBe(true);
    expect(model.supportedReason).toBeNull();
    // Root-level quants are artifacts the runtime can name.
    expect(model.artifacts.filter((a) => a.format === "gguf").length).toBeGreaterThanOrEqual(3);
  });
});
