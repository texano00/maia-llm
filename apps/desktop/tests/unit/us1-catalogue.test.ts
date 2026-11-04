import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isChatCapableModel, isGgufOnlyRepository } from "@maia/contracts";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { CatalogueRepository } from "../../src/main/services/catalogue/repository";
import { CatalogueService, filterAndSort, type CatalogueSource } from "../../src/main/services/catalogue/service";
import { assertChatRunnable } from "../../src/main/services/catalogue/runnable";
import { assessRepository } from "../../src/main/services/catalogue/repository-check";
import {
  createHuggingFaceSource,
  tokenizerConfigHasTemplate
} from "../../src/main/services/catalogue/huggingface-source";
import { ProviderHttpError, type ProviderHttpClient } from "../../src/main/services/providers/http";
import {
  mapArtifacts,
  mapHuggingFaceModel,
  readFormat,
  type HuggingFaceModelPayload
} from "../../src/main/services/catalogue/mapper";

const payload: HuggingFaceModelPayload = {
  id: "Qwen/Qwen2.5-7B-Instruct",
  downloads: 1000,
  likes: 42,
  gated: "manual",
  pipeline_tag: "text-generation",
  lastModified: "2026-10-01T00:00:00.000Z",
  tags: ["license:apache-2.0", "text-generation"],
  cardData: { context_length: 32768 },
  safetensors: { parameters: { BF16: 7_000_000_000 } }
};

describe("Hugging Face mapping", () => {
  it("maps identity, license, gating, and architecture facts", () => {
    const model = mapHuggingFaceModel(payload, "2026-11-03T00:00:00.000Z");

    expect(model).toMatchObject({
      id: "Qwen/Qwen2.5-7B-Instruct",
      author: "Qwen",
      name: "Qwen2.5-7B-Instruct",
      license: "apache-2.0",
      gated: "manual",
      parameterCount: 7_000_000_000,
      contextWindow: 32768,
      downloads: 1000,
      likes: 42
    });
  });

  it("normalises gated flags and falls back to license tags", () => {
    const model = mapHuggingFaceModel(
      { ...payload, gated: true, cardData: null, tags: ["license:mit"] },
      "2026-11-03T00:00:00.000Z"
    );

    expect(model.gated).toBe("manual");
    expect(model.license).toBe("mit");
    expect(model.contextWindow).toBeNull();
  });

  it("does not advertise chat for a model vLLM cannot chat with", () => {
    // The exact model that was rented by mistake: an embedding model boots and
    // then answers every message with 404.
    const embedding = mapHuggingFaceModel(
      {
        id: "BAAI/bge-small-en-v1.5",
        pipeline_tag: "sentence-similarity",
        tags: ["sentence-transformers", "feature-extraction"],
        downloads: 10,
        likes: 1
      },
      "2026-11-04T00:00:00.000Z"
    );

    expect(embedding.capabilities).not.toContain("chat");
    expect(isChatCapableModel(embedding)).toBe(false);
    expect(isChatCapableModel(mapHuggingFaceModel(payload, "2026-11-04T00:00:00.000Z"))).toBe(true);
  });

  it("recognises a GGUF-only repository as unservable by vLLM", () => {
    const ggufOnly = mapArtifacts("a/gguf", "main", [
      { type: "file", path: "model-Q4_K_M.gguf", lfs: { size: 15_000_000_000, sha256: "b".repeat(64) } },
      { type: "file", path: "README.md", size: 100 }
    ]);
    const both = mapArtifacts("a/both", "main", [
      { type: "file", path: "model.Q4_K_M.gguf", lfs: { size: 15_000_000_000, sha256: "c".repeat(64) } },
      { type: "file", path: "model-00001-of-00002.safetensors", lfs: { size: 14_000_000_000, sha256: "d".repeat(64) } }
    ]);

    expect(isGgufOnlyRepository(ggufOnly)).toBe(true);
    expect(isGgufOnlyRepository(both)).toBe(false);
    // Nothing known yet: do not block the user.
    expect(isGgufOnlyRepository([])).toBe(false);
  });

  it("maps artifact formats, quantisation, and LFS sizes", () => {
    const artifacts = mapArtifacts("Qwen/Qwen2.5-7B-Instruct", "main", [
      { type: "file", path: "model-q4_k_m.gguf", size: 100, lfs: { size: 4_000_000, sha256: "a".repeat(64) } },
      { type: "file", path: "model.safetensors", size: 10 },
      { type: "file", path: "README.md", size: 10 },
      { type: "directory", path: "assets" }
    ]);

    const gguf = artifacts.find((artifact) => artifact.path.endsWith(".gguf"));
    expect(gguf).toMatchObject({
      format: "gguf",
      quantization: "Q4_K_M",
      sizeBytes: 4_000_000,
      isLfs: true,
      runnable: true
    });

    expect(readFormat("weights.safetensors")).toBe("safetensors");
    expect(readFormat("notes.txt")).toBe("other");
  });
});

describe("chat template detection", () => {
  it("reads the classic, multi-template and empty formats", () => {
    expect(tokenizerConfigHasTemplate(JSON.stringify({ chat_template: "{{ messages }}" }))).toBe(true);
    expect(
      tokenizerConfigHasTemplate(
        JSON.stringify({ chat_template: [{ name: "default", template: "{{ messages }}" }] })
      )
    ).toBe(true);
    // gpt2 and other base models: the key is absent or null.
    expect(tokenizerConfigHasTemplate(JSON.stringify({ model_max_length: 1024 }))).toBe(false);
    expect(tokenizerConfigHasTemplate(JSON.stringify({ chat_template: null }))).toBe(false);
    expect(tokenizerConfigHasTemplate(JSON.stringify({ chat_template: "   " }))).toBe(false);
    expect(tokenizerConfigHasTemplate("not json")).toBe(false);
  });

  it("falls back to the standalone chat_template.jinja file", async () => {
    const requested: string[] = [];
    const client = {
      async request(path: string) {
        requested.push(path);
        if (path.endsWith("/tokenizer_config.json")) {
          return new Response(JSON.stringify({ model_max_length: 1024 }));
        }
        if (path.endsWith("/chat_template.jinja")) {
          return new Response("{% for message in messages %}{{ message.content }}{% endfor %}");
        }
        throw new ProviderHttpError("INVALID_REQUEST", "not found", false, 404);
      }
    } as unknown as ProviderHttpClient;

    const source = createHuggingFaceSource({ client });

    await expect(source.getChatTemplate?.("org/new-style-chat")).resolves.toBe(true);
    expect(requested.some((path) => path.endsWith("/chat_template.jinja"))).toBe(true);
  });

  it("reports a base model as chat-less after checking both files", async () => {
    const client = {
      async request(path: string) {
        if (path.endsWith("/tokenizer_config.json")) {
          // The exact shape shipped by openai-community/gpt2.
          return new Response(JSON.stringify({ model_max_length: 1024, tokenizer_class: "GPT2Tokenizer" }));
        }
        throw new ProviderHttpError("INVALID_REQUEST", "not found", false, 404);
      }
    } as unknown as ProviderHttpClient;

    const source = createHuggingFaceSource({ client });

    await expect(source.getChatTemplate?.("openai-community/gpt2")).resolves.toBe(false);
  });

  it("caches the verdict and exposes it in the detail payload", async () => {
    const db = openDatabase(":memory:");
    try {
      const repository = new CatalogueRepository(db);
      let calls = 0;
      const source: CatalogueSource = {
        async listModels() {
          return [payload];
        },
        async getModel(id) {
          return {
            model: { ...payload, id },
            files: [
              { type: "file" as const, path: "config.json", size: 1 },
              { type: "file" as const, path: "model.safetensors", size: 1 }
            ]
          };
        },
        async getChatTemplate() {
          calls += 1;
          return false;
        }
      };
      const service = new CatalogueService({
        repository,
        source,
        now: () => new Date("2026-11-04T10:00:00.000Z")
      });

      const first = await service.detail("openai-community/gpt2");
      const second = await service.detail("openai-community/gpt2");

      expect(first.chatTemplate).toBe(false);
      expect(second.chatTemplate).toBe(false);
      expect(first.runnable).toBe(true);
      expect(calls).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });
});

describe("repository assessment", () => {
  const file = (path: string) => ({ type: "file" as const, path, size: 1 });

  it("refuses a ComfyUI diffusion pack that claims text-generation", () => {
    // Comfy-Org/MiniMax-H3 in the field: diffusion weights, no config.json.
    const verdict = assessRepository({ library_name: "diffusion-single-file" }, [
      file("diffusion_models/minimax_h3_fl2va_bf16.safetensors"),
      file("README.md")
    ]);

    expect(verdict).toEqual({
      loadable: false,
      problem: "is a ComfyUI diffusion pack, not a text-generation transformer"
    });
  });

  it("requires config.json when the repository ships safetensors", () => {
    const verdict = assessRepository({}, [file("model.safetensors")]);

    expect(verdict.loadable).toBe(false);
    expect(verdict.problem).toMatch(/no config\.json/);
  });

  it("accepts GGUF repositories, which carry their config in the file", () => {
    expect(assessRepository({}, [file("model-Q4_K_M.gguf")])).toEqual({
      loadable: true,
      problem: null
    });
  });

  it("accepts a transformers repository and refuses one without weights", () => {
    expect(
      assessRepository({ library_name: "transformers" }, [
        file("config.json"),
        file("model.safetensors"),
        file("tokenizer.json")
      ])
    ).toEqual({ loadable: true, problem: null });

    const noWeights = assessRepository({}, [file("README.md"), file("config.json")]);
    expect(noWeights.loadable).toBe(false);
    expect(noWeights.problem).toMatch(/neither \.safetensors nor \.gguf/);
  });
});

describe("start guard", () => {
  const catalogue = (
    pipelineTag: string | null,
    facts: { chatTemplate?: boolean | null; loadable?: boolean | null; problem?: string | null } = {}
  ) => ({
    get: () => ({ id: "model/selected", pipelineTag }),
    checkRepository: async () => ({
      chatTemplate: facts.chatTemplate ?? null,
      loadable: facts.loadable ?? null,
      problem: facts.problem ?? null
    })
  });

  it("refuses a base model before a GPU is rented", async () => {
    // The earlier field case: gpt2 is text-generation, boots fine, then 400s chat.
    await expect(
      assertChatRunnable(catalogue("text-generation", { chatTemplate: false }), "model/selected")
    ).rejects.toThrow(/defines no chat template/);
  });

  it("refuses a pipeline that has no chat endpoint at all", async () => {
    await expect(
      assertChatRunnable(catalogue("sentence-similarity", { loadable: true }), "model/selected")
    ).rejects.toThrow(/not a chat model/);
  });

  it("refuses a repository vLLM cannot load", async () => {
    // The MiniMax-H3 field case: tagged (or untagged) text-generation, but the
    // repository has no config.json and only diffusion weights.
    await expect(
      assertChatRunnable(
        catalogue(null, {
          loadable: false,
          problem: "is a ComfyUI diffusion pack, not a text-generation transformer"
        }),
        "model/selected"
      )
    ).rejects.toThrow(/cannot be served by vLLM: it is a ComfyUI diffusion pack/);
  });

  it("never blocks a start when a verdict could not be checked", async () => {
    await expect(assertChatRunnable(catalogue("text-generation"), "model/selected")).resolves.toBeUndefined();
    await expect(
      assertChatRunnable(catalogue("text-generation", { chatTemplate: true, loadable: true }), "model/selected")
    ).resolves.toBeUndefined();
  });
});

describe("catalogue filtering", () => {
  const models = [
    mapHuggingFaceModel({ ...payload, id: "a/one", downloads: 10 }, "2026-11-03T00:00:00.000Z"),
    mapHuggingFaceModel(
      { ...payload, id: "b/two", downloads: 90, gated: false, cardData: { context_length: 8192 } },
      "2026-11-03T00:00:00.000Z"
    )
  ];

  it("filters by search, gating, and sorts by downloads by default", () => {
    const result = filterAndSort(models, { search: "two" });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("b/two");

    expect(filterAndSort(models, { gated: "open" })).toHaveLength(1);
    expect(filterAndSort(models, {}).map((model) => model.id)).toEqual(["b/two", "a/one"]);
  });
});

describe("CatalogueService cache", () => {
  let db: DatabaseConnection;
  let repository: CatalogueRepository;

  beforeEach(() => {
    db = openDatabase(":memory:");
    repository = new CatalogueRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function createService(source: CatalogueSource, now: Date, ttlMs = 15 * 60_000) {
    return new CatalogueService({ repository, source, now: () => now, ttlMs });
  }

  const source: CatalogueSource = {
    async listModels() {
      return [payload];
    },
    async getModel(id) {
      return {
        model: { ...payload, id },
        files: [{ type: "file", path: "model.safetensors", size: 1_000 }]
      };
    }
  };

  it("caches the snapshot and serves it without a second network call inside the TTL", async () => {
    let calls = 0;
    const counted: CatalogueSource = {
      ...source,
      async listModels() {
        calls += 1;
        return [payload];
      }
    };

    const service = createService(counted, new Date("2026-11-03T10:00:00.000Z"));
    const first = await service.search({});
    const second = await service.search({});

    expect(first.models).toHaveLength(1);
    expect(second.stale).toBe(false);
    expect(calls).toBe(1);
  });

  it("marks results stale and keeps serving the cache when the refresh fails", async () => {
    const failing: CatalogueSource = {
      async listModels() {
        throw new Error("network down");
      },
      async getModel() {
        throw new Error("network down");
      }
    };

    const service = createService(source, new Date("2026-11-03T10:00:00.000Z"));
    await service.search({});

    const offline = new CatalogueService({ repository, source: failing, now: () => new Date("2026-11-03T11:00:00.000Z") });
    const result = await offline.search({});

    expect(result.stale).toBe(true);
    expect(result.models).toHaveLength(1);
  });

  it("stores artifacts when opening a detail view", async () => {
    const service = createService(source, new Date("2026-11-03T10:00:00.000Z"));
    const detail = await service.detail("Qwen/Qwen2.5-7B-Instruct");

    expect(detail.model.id).toBe("Qwen/Qwen2.5-7B-Instruct");
    expect(detail.artifacts).toHaveLength(1);
    expect(detail.stale).toBe(false);
  });
});

describe("CatalogueService remote search", () => {
  let db: DatabaseConnection;
  let repository: CatalogueRepository;

  beforeEach(() => {
    db = openDatabase(":memory:");
    repository = new CatalogueRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("asks the provider for the search term and caches the results", async () => {
    const terms: Array<string | undefined> = [];
    const source: CatalogueSource = {
      async listModels(options) {
        terms.push(options.search);
        return [{ ...payload, id: `result/${options.search ?? "all"}` }];
      },
      async getModel(id) {
        return { model: { ...payload, id }, files: [] };
      }
    };

    const service = new CatalogueService({
      repository,
      source,
      now: () => new Date("2026-11-04T10:00:00.000Z")
    });

    const result = await service.search({ search: "mistral" });

    expect(terms.at(-1)).toBe("mistral");
    expect(result.models.map((model) => model.id)).toContain("result/mistral");
    expect(result.stale).toBe(false);

    // The fetched model is now part of the offline snapshot.
    expect(repository.get("result/mistral")).not.toBeNull();
  });

  it("falls back to the cached snapshot when the search request fails", async () => {
    const cached: CatalogueSource = {
      async listModels() {
        return [payload];
      },
      async getModel() {
        throw new Error("unused");
      }
    };

    const service = new CatalogueService({
      repository,
      source: cached,
      now: () => new Date("2026-11-04T10:00:00.000Z")
    });
    await service.search({});

    const failing: CatalogueSource = {
      async listModels() {
        throw new Error("network down");
      },
      async getModel() {
        throw new Error("network down");
      }
    };

    const offline = new CatalogueService({
      repository,
      source: failing,
      now: () => new Date("2026-11-04T11:00:00.000Z")
    });

    const result = await offline.search({ search: "qwen" });

    expect(result.stale).toBe(true);
    expect(result.models.map((model) => model.id)).toContain(payload.id);
  });
});
