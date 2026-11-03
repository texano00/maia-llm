import type { CatalogueQuery, CatalogueResult, ModelDetail } from "@maia/contracts";
import type { CatalogueRepository } from "./repository";
import { mapArtifacts, mapHuggingFaceModel, type HuggingFaceModelPayload, type HuggingFaceTreeEntry } from "./mapper";

export interface CatalogueSource {
  /** Latest model listing, optionally scoped by a search term. */
  listModels(options: { search?: string; limit: number }): Promise<HuggingFaceModelPayload[]>;
  /** Single model plus its file tree. */
  getModel(id: string): Promise<{ model: HuggingFaceModelPayload; files: HuggingFaceTreeEntry[] }>;
}

export interface CatalogueServiceOptions {
  repository: CatalogueRepository;
  source: CatalogueSource;
  now?: () => Date;
  ttlMs?: number;
  logger?: { info(message: string, context?: Record<string, unknown>): void; warn(message: string, context?: Record<string, unknown>): void } | undefined;
}

const ACCEPTED_LICENSES = new Set<string>();

/**
 * Search is served from the SQLite snapshot; the network is only consulted when
 * the snapshot is older than the TTL or when the user asks for a refresh. A
 * failed refresh never hides the cache — it is returned with `stale: true`.
 */
export class CatalogueService {
  private readonly now: () => Date;

  constructor(private readonly options: CatalogueServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async search(query: CatalogueQuery = {}): Promise<CatalogueResult> {
    const ttlMs = this.options.ttlMs;
    if (!this.options.repository.isFresh(ttlMs, this.now())) {
      try {
        await this.refresh();
      } catch (error) {
        this.options.logger?.warn("Catalogue refresh failed; serving the cached snapshot", {
          message: errorMessage(error)
        });
      }
    }

    const { models, cachedAt } = this.options.repository.list();
    const expected = this.options.repository.isFresh(ttlMs, this.now());

    return {
      models: filterAndSort(models, query),
      stale: !expected,
      fetchedAt: cachedAt ?? this.now().toISOString()
    };
  }

  async refresh(): Promise<CatalogueResult> {
    const payloads = await this.options.source.listModels({ limit: 100 });
    const cachedAt = this.now().toISOString();
    const models = payloads.map((payload) => mapHuggingFaceModel(payload, cachedAt));

    this.options.repository.saveModels(models);

    return {
      models,
      stale: false,
      fetchedAt: cachedAt
    };
  }

  async detail(id: string): Promise<ModelDetail> {
    let stale = !this.options.repository.isFresh(this.options.ttlMs, this.now());

    try {
      const { model, files } = await this.options.source.getModel(id);
      const mapped = mapHuggingFaceModel(model, this.now().toISOString());
      const artifacts = mapArtifacts(id, "main", files);

      this.options.repository.saveModels([mapped]);
      this.options.repository.saveArtifacts(artifacts);
      stale = false;
    } catch (error) {
      const cached = this.options.repository.get(id);
      if (!cached) {
        throw error;
      }

      this.options.logger?.warn("Model detail refresh failed; serving the cached record", {
        modelId: id,
        message: errorMessage(error)
      });
      stale = true;
    }

    const model = this.options.repository.get(id);
    if (!model) {
      throw new Error(`Unknown model: ${id}`);
    }

    return {
      model,
      artifacts: this.options.repository.getArtifacts(id),
      licenseAccepted: ACCEPTED_LICENSES.has(id),
      stale
    };
  }

  acceptLicense(id: string): ModelDetail {
    ACCEPTED_LICENSES.add(id);
    const model = this.options.repository.get(id);
    if (!model) {
      throw new Error(`Unknown model: ${id}`);
    }

    return {
      model,
      artifacts: this.options.repository.getArtifacts(id),
      licenseAccepted: true,
      stale: !this.options.repository.isFresh(this.options.ttlMs, this.now())
    };
  }
}

export function filterAndSort(
  models: CatalogueResult["models"],
  query: CatalogueQuery
): CatalogueResult["models"] {
  const search = query.search?.toLowerCase();
  const limit = query.limit ?? 50;

  const filtered = models.filter((model) => {
    if (search && !`${model.id} ${model.author} ${model.name}`.toLowerCase().includes(search)) {
      return false;
    }
    if (query.license && model.license?.toLowerCase() !== query.license.toLowerCase()) {
      return false;
    }
    if (query.gated === "open" && model.gated !== "none") {
      return false;
    }
    if (query.gated === "gated" && model.gated === "none") {
      return false;
    }
    if (query.maxParameters && (model.parameterCount ?? 0) > query.maxParameters) {
      return false;
    }
    if (query.minContextWindow && (model.contextWindow ?? 0) < query.minContextWindow) {
      return false;
    }
    if (query.capability && !model.capabilities.includes(query.capability)) {
      return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((left, right) => {
    switch (query.sort) {
      case "likes":
        return right.likes - left.likes;
      case "last-modified":
        return (right.lastModifiedAt ?? "").localeCompare(left.lastModifiedAt ?? "");
      case "parameters-asc":
        return (left.parameterCount ?? Number.MAX_SAFE_INTEGER) - (right.parameterCount ?? Number.MAX_SAFE_INTEGER);
      case "parameters-desc":
        return (right.parameterCount ?? 0) - (left.parameterCount ?? 0);
      case "context-desc":
        return (right.contextWindow ?? 0) - (left.contextWindow ?? 0);
      case "downloads":
      default:
        return right.downloads - left.downloads;
    }
  });

  return sorted.slice(0, limit);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
