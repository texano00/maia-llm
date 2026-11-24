import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogueService, type CatalogueSource } from "../../src/main/services/catalogue/service";
import { CatalogueRepository } from "../../src/main/services/catalogue/repository";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";

/**
 * A slow catalogue must answer, not hang (feature 012, edge timeout).
 *
 * The reported failure was a Hub search that held the request open until
 * Cloudflare gave up and returned its own 504 page. These tests pin the three
 * behaviours that prevent it: a deadline, a warm cache, and one in-flight call
 * per query.
 */

const payload = (id: string) => ({
  id,
  author: id.split("/")[0] ?? "org",
  downloads: 10,
  likes: 1,
  tags: ["text-generation"],
  pipeline_tag: "text-generation",
  lastModified: "2026-11-24T10:00:00.000Z",
  gated: false
});

function serviceWith(source: Partial<CatalogueSource>, db: DatabaseConnection) {
  const repository = new CatalogueRepository(db);
  const service = new CatalogueService({
    repository,
    source: {
      listModels: async () => [],
      getModel: async () => {
        throw new Error("not used");
      },
      ...source
    } as CatalogueSource,
    searchBudgetMs: 25
  });

  return { service, repository };
}

describe("catalogue search under a slow provider", () => {
  let db: DatabaseConnection;

  afterEach(() => {
    if (db) {
      closeDatabase(db);
    }
  });

  it("answers with the cached list instead of waiting past its budget", async () => {
    db = openDatabase(":memory:");
    const { service, repository } = serviceWith(
      {
        // A listing that never settles is the worst case a search can meet.
        listModels: () => new Promise(() => undefined)
      },
      db
    );

    // The cache already holds a page, as it does in production.
    repository.saveModels([
      {
        id: "org/known-model",
        author: "org",
        name: "known-model",
        license: null,
        pipelineTag: "text-generation",
        parameterCount: null,
        contextWindow: null,
        downloads: 100,
        likes: 1,
        gated: "none",
        lastModifiedAt: null,
        tags: ["text-generation"],
        capabilities: ["text"],
        cachedAt: "2026-11-24T10:00:00.000Z"
      } as never
    ]);

    const started = Date.now();
    const result = await service.search({ search: "known", limit: 100 });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.stale).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
  });

  it("serves a repeated query from the cache without asking upstream again", async () => {
    db = openDatabase(":memory:");
    const listModels = vi.fn(async () => [payload("org/abliterated")]);
    const { service } = serviceWith({ listModels }, db);

    await service.search({ search: "abliterated", limit: 100 });
    await service.search({ search: "abliterated", limit: 100 });
    await service.search({ search: "  abliterated  ", limit: 100 });

    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("coalesces identical searches while one is still in flight", async () => {
    db = openDatabase(":memory:");
    let resolveListing: (value: unknown[]) => void = () => undefined;
    const listModels = vi.fn(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveListing = resolve;
        })
    );
    const { service } = serviceWith({ listModels }, db);

    const first = service.search({ search: "qwen3", limit: 100 });
    const second = service.search({ search: "qwen3", limit: 100 });
    resolveListing([]);

    const [a, b] = await Promise.all([first, second]);
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(a.fetchedAt).toBe(b.fetchedAt);
  });
});
