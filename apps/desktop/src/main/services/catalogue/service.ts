import type {
  CatalogueModel,
  CatalogueQuery,
  CatalogueResult,
  CatalogueSnapshotInfo,
  ModelArtifact,
  ModelDetail,
  ModelSupport
} from "@maia/contracts";
import { isChatCapableModel } from "@maia/contracts";
import type { CatalogueRepository } from "./repository";
import { mapArtifacts, mapHuggingFaceModel, type HuggingFaceModelPayload, type HuggingFaceTreeEntry } from "./mapper";
import { assessRepository, type RepositoryVerdict } from "./repository-check";

export type CatalogueSupport = ModelSupport;
export type { CatalogueSnapshotInfo };

export interface CatalogueSource {
  /** Latest model listing, optionally scoped by a search term. */
  listModels(options: { search?: string; limit: number }): Promise<HuggingFaceModelPayload[]>;
  /** Single model plus its file tree. */
  getModel(id: string): Promise<{ model: HuggingFaceModelPayload; files: HuggingFaceTreeEntry[] }>;
  /**
   * Does the repository define a chat template? Optional: an offline fixture has
   * no tokenizer config to inspect and reports nothing.
   */
  getChatTemplate?(id: string): Promise<boolean>;
  /**
   * The backend's engine/support verdict, when the source has one. Synchronous
   * because it reads an already fetched snapshot; `null` means "not known".
   */
  getSupport?(id: string): CatalogueSupport | null;
  /** Artifacts the source already mapped (snapshot sources know quantization). */
  getArtifacts?(id: string): ModelArtifact[];
  /** Which snapshot the listing came from, for the "catalogue is N minutes old" line. */
  snapshotInfo?(): CatalogueSnapshotInfo | null;
}

export interface CatalogueServiceOptions {
  repository: CatalogueRepository;
  source: CatalogueSource;
  now?: () => Date;
  ttlMs?: number;
  logger?: { info(message: string, context?: Record<string, unknown>): void; warn(message: string, context?: Record<string, unknown>): void } | undefined;
}

const ACCEPTED_LICENSES = new Set<string>();

/** What a start needs to know about a repository, beyond its pipeline tag. */
export interface RepositoryCheck extends RepositoryVerdict {
  chatTemplate: boolean | null;
}

const UNKNOWN_REPOSITORY: RepositoryVerdict = { loadable: null, problem: null };

/**
 * The SQLite snapshot serves instant results and offline browsing; a search term
 * is also sent to the provider so models outside the cached page can be found.
 * A failed request never hides the cache — it is returned with `stale: true`.
 */
export class CatalogueService {
  private readonly now: () => Date;
  /** Chat-template verdicts, so a start does not re-fetch the tokenizer config. */
  private readonly chatTemplates = new Map<string, boolean>();
  /** Repository verdicts (config.json, weights), also cached per model. */
  private readonly repositories = new Map<string, RepositoryVerdict>();

  constructor(private readonly options: CatalogueServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Everything a start must know before renting a GPU: can vLLM boot this
   * repository, and can it answer chat requests? All the falsy-but-known
   * verdicts block the start; `null` (could not check) does not.
   */
  async checkRepository(id: string): Promise<RepositoryCheck> {
    const known = this.options.source.getSupport?.(id) ?? null;
    if (known) {
      return { chatTemplate: null, loadable: known.supported, problem: known.reason };
    }

    const verdict = this.repositories.get(id) ?? (await this.probeRepository(id));

    // Probing fetched the model, so a snapshot source can answer now even when
    // the catalogue has not been listed yet in this run.
    const support = this.options.source.getSupport?.(id) ?? null;
    if (support) {
      return { chatTemplate: null, loadable: support.supported, problem: support.reason };
    }

    const chatTemplate = await this.hasChatTemplate(id);
    return { chatTemplate, loadable: verdict.loadable, problem: verdict.problem };
  }

  private async probeRepository(id: string): Promise<RepositoryVerdict> {
    if (!this.options.source.getModel) {
      return UNKNOWN_REPOSITORY;
    }

    try {
      const { model, files } = await this.options.source.getModel(id);
      const verdict = assessRepository(model, files);
      this.repositories.set(id, verdict);
      return verdict;
    } catch (error) {
      // A Hub hiccup must not stop a session: only a definite verdict does.
      this.options.logger?.warn("Could not inspect the model repository", {
        modelId: id,
        message: errorMessage(error)
      });
      return UNKNOWN_REPOSITORY;
    }
  }

  /**
   * Whether the repository defines a chat template. `null` means "could not
   * check" (offline, rate limited, provider without support) and must never
   * block a start on its own.
   */
  async hasChatTemplate(id: string): Promise<boolean | null> {
    const cached = this.chatTemplates.get(id);
    if (cached !== undefined) {
      return cached;
    }

    if (!this.options.source.getChatTemplate) {
      return null;
    }

    try {
      const verdict = await this.options.source.getChatTemplate(id);
      this.chatTemplates.set(id, verdict);
      return verdict;
    } catch (error) {
      // The check is an optimisation: a Hub hiccup must not stop a session.
      this.options.logger?.warn("Could not check whether the model defines a chat template", {
        modelId: id,
        message: errorMessage(error)
      });
      return null;
    }
  }

  async search(query: CatalogueQuery = {}): Promise<CatalogueResult> {
    const ttlMs = this.options.ttlMs;
    const term = query.search?.trim() ?? "";
    const needsRefresh = term.length >= 2 || !this.options.repository.isFresh(ttlMs, this.now());
    let stale = !this.options.repository.isFresh(ttlMs, this.now());

    if (needsRefresh) {
      try {
        await this.refreshInto(term);
        stale = false;
      } catch (error) {
        this.options.logger?.warn("Catalogue refresh failed; serving the cached snapshot", {
          search: term,
          message: errorMessage(error)
        });
        stale = true;
      }
    }

    const { models, cachedAt } = this.options.repository.list();

    return {
      models: filterAndSort(this.withSupport(models), query),
      stale,
      fetchedAt: cachedAt ?? this.now().toISOString(),
      snapshot: this.options.source.snapshotInfo?.() ?? null
    };
  }

  /** Attaches the backend verdict to cached rows; unknown stays unknown. */
  private withSupport(models: CatalogueModel[]): CatalogueModel[] {
    if (!this.options.source.getSupport) {
      return models;
    }

    return models.map((model) => {
      const support = this.options.source.getSupport?.(model.id) ?? null;
      return support
        ? {
            ...model,
            supported: support.supported,
            supportedReason: support.reason,
            engine: support.engine
          }
        : model;
    });
  }

  async refresh(): Promise<CatalogueResult> {
    const result = await this.refreshInto("");
    return {
      ...result,
      models: this.withSupport(result.models),
      snapshot: this.options.source.snapshotInfo?.() ?? null
    };
  }

  /** Cached record, without touching the network. */
  get(id: string): CatalogueModel | null {
    return this.options.repository.get(id);
  }

  /**
   * The backend verdict, when the source has one. Synchronous on purpose: it
   * reads the snapshot the current listing came from.
   */
  supportFor(id: string): ModelSupport | null {
    return this.options.source.getSupport?.(id) ?? null;
  }

  private async refreshInto(search: string): Promise<CatalogueResult> {
    const payloads = await this.options.source.listModels({
      limit: 100,
      ...(search.length > 0 ? { search } : {})
    });
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
      // A snapshot source maps its own artifacts: quantization comes from the
      // backend, and re-deriving it from file names would lose information.
      const artifacts = this.options.source.getArtifacts?.(id) ?? mapArtifacts(id, "main", files);

      this.repositories.set(id, assessRepository(model, files));
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

    const verdict = this.repositories.get(id) ?? UNKNOWN_REPOSITORY;
    const support = this.options.source.getSupport?.(id) ?? null;

    return {
      model: this.withSupport([model])[0] ?? model,
      artifacts: this.options.repository.getArtifacts(id),
      chatTemplate: await this.hasChatTemplate(id),
      runnable: support ? support.supported : verdict.loadable,
      runnableProblem: support ? support.reason : verdict.problem,
      licenseAccepted: ACCEPTED_LICENSES.has(id),
      support,
      stale
    };
  }

  acceptLicense(id: string): ModelDetail {
    ACCEPTED_LICENSES.add(id);
    const model = this.options.repository.get(id);
    if (!model) {
      throw new Error(`Unknown model: ${id}`);
    }

    const verdict = this.repositories.get(id) ?? UNKNOWN_REPOSITORY;

    return {
      model,
      artifacts: this.options.repository.getArtifacts(id),
      chatTemplate: this.chatTemplates.get(id) ?? null,
      runnable: verdict.loadable,
      runnableProblem: verdict.problem,
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
    // Only a known `false` is hidden: a Hub-sourced row has no verdict yet and
    // must not disappear just because the backend has not spoken. Pipeline
    // verdicts are local knowledge though — an embedding or reranking model is
    // never runnable, however the catalogue scored it.
    if (query.supportedOnly && (model.supported === false || !isChatCapableModel(model))) {
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
