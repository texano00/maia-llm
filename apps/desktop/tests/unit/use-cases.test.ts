import { describe, expect, it } from "vitest";
import type { CatalogueModel, ModelSupport } from "@maia/contracts";
import { createUseCaseResolver, type CuratedUseCase } from "../../src/main/services/catalogue/use-cases";
import type { CatalogueService } from "../../src/main/services/catalogue/service";

interface FakeModel {
  model: CatalogueModel;
  support: ModelSupport | null;
}

function model(id: string): CatalogueModel {
  return {
    id,
    author: id.split("/")[0] ?? id,
    name: id.split("/")[1] ?? id,
    license: null,
    pipelineTag: "text-generation",
    parameterCount: null,
    contextWindow: null,
    downloads: 0,
    likes: 0,
    gated: "none",
    lastModifiedAt: null,
    tags: [],
    capabilities: ["chat"],
    cachedAt: "2026-11-07T10:00:00.000Z"
  };
}

function catalogueOf(entries: FakeModel[], calls: string[] = []): CatalogueService {
  return {
    async search() {
      calls.push("search");
      return { models: entries.map((entry) => entry.model), stale: false, fetchedAt: "x" };
    },
    get(id: string) {
      return entries.find((entry) => entry.model.id === id)?.model ?? null;
    },
    supportFor(id: string) {
      return entries.find((entry) => entry.model.id === id)?.support ?? null;
    }
  } as unknown as CatalogueService;
}

const useCase: CuratedUseCase = {
  id: "coding",
  title: "Write and review code",
  description: "Long-context answers for repository work.",
  imageUrl: null,
  models: ["acme/gpt2", "acme/retired", "acme/qwen14b"]
};

const supported = (id: string): FakeModel => ({
  model: model(id),
  support: { supported: true, engine: "vllm", reason: null }
});

const unsupported = (id: string, reason: string): FakeModel => ({
  model: model(id),
  support: { supported: false, engine: "vllm", reason }
});

describe("basic-mode use cases", () => {
  it("resolves to the first curated model it can run", async () => {
    const calls: string[] = [];
    const resolve = createUseCaseResolver({
      list: async () => [useCase],
      catalogue: catalogueOf(
        [
          unsupported("acme/gpt2", "the model defines no chat template"),
          supported("acme/qwen14b")
        ],
        calls
      )
    });

    const cards = await resolve();

    expect(cards).toEqual([
      {
        id: "coding",
        title: "Write and review code",
        description: "Long-context answers for repository work.",
        imageUrl: null,
        modelId: "acme/qwen14b",
        modelName: "qwen14b",
        reason: null
      }
    ]);
    // The catalogue is listed first: that is what fills the support map.
    expect(calls).toEqual(["search"]);
  });

  it("explains a card whose every model is unusable", async () => {
    const resolve = createUseCaseResolver({
      list: async () => [{ ...useCase, models: ["acme/gpt2"] }],
      catalogue: catalogueOf([unsupported("acme/gpt2", "the model defines no chat template")])
    });

    const [card] = await resolve();

    expect(card?.modelId).toBeNull();
    expect(card?.reason).toContain("no chat template");
  });

  it("mentions a model that has left the snapshot", async () => {
    const resolve = createUseCaseResolver({
      list: async () => [{ ...useCase, models: ["acme/delisted"] }],
      catalogue: catalogueOf([supported("acme/qwen14b")])
    });

    const [card] = await resolve();

    expect(card?.reason).toContain("not in the current catalogue");
  });

  it("trusts the curated order when the source has no verdicts", async () => {
    const resolve = createUseCaseResolver({
      list: async () => [{ ...useCase, models: ["acme/unknown"] }],
      catalogue: catalogueOf([{ model: model("acme/unknown"), support: null }])
    });

    const [card] = await resolve();

    expect(card?.modelId).toBe("acme/unknown");
    expect(card?.reason).toBeNull();
  });

  it("returns nothing without a portal, and survives a failing backend", async () => {
    const withoutBackend = createUseCaseResolver({ list: null, catalogue: catalogueOf([]) });
    const warnings: string[] = [];
    const failing = createUseCaseResolver({
      list: async () => {
        throw new Error("portal is down");
      },
      catalogue: catalogueOf([]),
      logger: {
        warn(message: string) {
          warnings.push(message);
        }
      }
    });

    await expect(withoutBackend()).resolves.toEqual([]);
    await expect(failing()).resolves.toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
