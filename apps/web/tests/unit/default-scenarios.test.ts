import { describe, expect, it } from "vitest";
import type { CatalogueModel } from "@maia/contracts";
import { deriveDefaultScenarios } from "../../src/main/services/catalogue/default-scenarios";

function model(overrides: Partial<CatalogueModel> & { id: string }): CatalogueModel {
  return {
    author: overrides.id.split("/")[0] ?? "x",
    name: overrides.id.split("/")[1] ?? overrides.id,
    license: null,
    pipelineTag: "text-generation",
    parameterCount: 7_000_000_000,
    contextWindow: 32_000,
    downloads: 1_000,
    likes: 1,
    gated: "none",
    lastModifiedAt: null,
    tags: [],
    capabilities: ["text"],
    artifacts: [],
    engine: "vllm",
    supported: true,
    supportedReason: null,
    ...overrides
  } as CatalogueModel;
}

describe("default basic-mode scenarios", () => {
  it("offers only models the backend marked runnable", () => {
    const cards = deriveDefaultScenarios([
      model({ id: "a/unsupported", supported: false, downloads: 9_000_000 }),
      model({ id: "a/runnable", downloads: 10 })
    ]);

    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((card) => card.modelId === "a/runnable")).toBe(true);
  });

  it("says nothing when the catalogue has nothing runnable", () => {
    expect(deriveDefaultScenarios([model({ id: "a/x", supported: false })])).toEqual([]);
    expect(deriveDefaultScenarios([])).toEqual([]);
  });

  it("picks the most downloaded model first", () => {
    const [first] = deriveDefaultScenarios([
      model({ id: "a/popular", downloads: 5_000 }),
      model({ id: "a/quiet", downloads: 5 })
    ]);

    expect(first?.modelId).toBe("a/popular");
    expect(first?.id).toBe("default-best");
  });

  it("picks the smallest model for the quick card", () => {
    const cards = deriveDefaultScenarios([
      model({ id: "a/big", downloads: 900, parameterCount: 70_000_000_000 }),
      model({ id: "a/small", downloads: 10, parameterCount: 500_000_000 })
    ]);

    expect(cards.find((card) => card.id === "default-small")?.modelId).toBe("a/small");
  });

  it("only adds a capability card when such a model exists", () => {
    const withoutVision = deriveDefaultScenarios([model({ id: "a/plain" })]);
    expect(withoutVision.some((card) => card.id === "default-vision")).toBe(false);

    const withVision = deriveDefaultScenarios([
      model({ id: "a/eyes", capabilities: ["text", "vision"], downloads: 1 })
    ]);
    expect(withVision.some((card) => card.id === "default-vision")).toBe(true);
  });

  it("never repeats a generic card's model, but may reuse it for a capability", () => {
    const cards = deriveDefaultScenarios([
      model({ id: "a/only", capabilities: ["text", "code", "vision"], contextWindow: 128_000 })
    ]);

    const generic = cards.filter((card) => !card.id.startsWith("default-code") && !card.id.startsWith("default-vision"));
    const genericIds = generic.map((card) => card.modelId);
    expect(new Set(genericIds).size).toBe(genericIds.length);

    // One model can answer more than one question; hiding the second asks the
    // person to guess.
    expect(cards.some((card) => card.id === "default-code")).toBe(true);
    expect(cards.some((card) => card.id === "default-vision")).toBe(true);
  });
});
