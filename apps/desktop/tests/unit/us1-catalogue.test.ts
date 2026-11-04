import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isChatCapableModel } from "@maia/contracts";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { CatalogueRepository } from "../../src/main/services/catalogue/repository";
import { CatalogueService, filterAndSort, type CatalogueSource } from "../../src/main/services/catalogue/service";
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
