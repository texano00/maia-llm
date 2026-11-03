import type { CatalogueModel, ModelArtifact } from "@maia/contracts";
import type { DatabaseConnection } from "../../storage/db";
import { deriveCapabilities } from "./mapper";

interface CatalogueRow {
  id: string;
  author: string;
  name: string;
  license: string | null;
  pipeline_tag: string | null;
  parameter_count: number | null;
  context_window: number | null;
  downloads: number;
  likes: number;
  gated: "none" | "auto" | "manual";
  last_modified_at: string | null;
  tags_json: string;
  etag: string | null;
  cached_at: string;
}

interface ArtifactRow {
  id: string;
  model_id: string;
  revision: string;
  path: string;
  format: "safetensors" | "gguf" | "other";
  quantization: string | null;
  size_bytes: number;
  sha256: string | null;
  is_lfs: number;
  runnable: number;
}

export const CATALOGUE_TTL_MS = 15 * 60 * 1000;

/**
 * SQLite snapshot of the Hugging Face catalogue. The cache is what makes the
 * catalogue usable offline (FR-004) and what lets the UI flag stale results.
 */
export class CatalogueRepository {
  constructor(private readonly database: DatabaseConnection) {}

  isFresh(ttlMs = CATALOGUE_TTL_MS, now = new Date()): boolean {
    const row = this.database
      .prepare("SELECT MAX(cached_at) AS cachedAt FROM catalogue_models")
      .get() as { cachedAt: string | null } | undefined;

    if (!row?.cachedAt) {
      return false;
    }

    return now.getTime() - new Date(row.cachedAt).getTime() < ttlMs;
  }

  list(): { models: CatalogueModel[]; cachedAt: string | null } {
    const rows = this.database
      .prepare("SELECT * FROM catalogue_models ORDER BY downloads DESC, id ASC")
      .all() as CatalogueRow[];

    const cachedAt = rows.reduce<string | null>(
      (latest, row) => (latest === null || row.cached_at > latest ? row.cached_at : latest),
      null
    );

    return { models: rows.map(toModel), cachedAt };
  }

  get(id: string): CatalogueModel | null {
    const row = this.database
      .prepare("SELECT * FROM catalogue_models WHERE id = ?")
      .get(id) as CatalogueRow | undefined;

    return row ? toModel(row) : null;
  }

  getArtifacts(modelId: string): ModelArtifact[] {
    const rows = this.database
      .prepare("SELECT * FROM model_artifacts WHERE model_id = ? ORDER BY path ASC")
      .all(modelId) as ArtifactRow[];

    return rows.map((row) => ({
      id: row.id,
      modelId: row.model_id,
      revision: row.revision,
      path: row.path,
      format: row.format,
      quantization: row.quantization,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      isLfs: row.is_lfs === 1,
      runnable: row.runnable === 1
    }));
  }

  saveModels(models: CatalogueModel[], etag: string | null = null): void {
    const statement = this.database.prepare(
      `INSERT INTO catalogue_models
         (id, author, name, license, pipeline_tag, parameter_count, context_window,
          downloads, likes, gated, last_modified_at, tags_json, etag, cached_at)
       VALUES
         (@id, @author, @name, @license, @pipelineTag, @parameterCount, @contextWindow,
          @downloads, @likes, @gated, @lastModifiedAt, @tagsJson, @etag, @cachedAt)
       ON CONFLICT(id) DO UPDATE SET
         author = excluded.author,
         name = excluded.name,
         license = excluded.license,
         pipeline_tag = excluded.pipeline_tag,
         parameter_count = excluded.parameter_count,
         context_window = excluded.context_window,
         downloads = excluded.downloads,
         likes = excluded.likes,
         gated = excluded.gated,
         last_modified_at = excluded.last_modified_at,
         tags_json = excluded.tags_json,
         etag = excluded.etag,
         cached_at = excluded.cached_at`
    );

    const write = this.database.transaction((items: CatalogueModel[]) => {
      for (const model of items) {
        statement.run({
          id: model.id,
          author: model.author,
          name: model.name,
          license: model.license,
          pipelineTag: model.pipelineTag,
          parameterCount: model.parameterCount,
          contextWindow: model.contextWindow,
          downloads: model.downloads,
          likes: model.likes,
          gated: model.gated,
          lastModifiedAt: model.lastModifiedAt,
          tagsJson: JSON.stringify(model.tags),
          etag,
          cachedAt: model.cachedAt
        });
      }
    });

    write(models);
  }

  saveArtifacts(artifacts: ModelArtifact[]): void {
    if (artifacts.length === 0) {
      return;
    }

    const statement = this.database.prepare(
      `INSERT INTO model_artifacts
         (id, model_id, revision, path, format, quantization, size_bytes, sha256, is_lfs, runnable)
       VALUES
         (@id, @modelId, @revision, @path, @format, @quantization, @sizeBytes, @sha256, @isLfs, @runnable)
       ON CONFLICT(model_id, revision, path) DO UPDATE SET
         size_bytes = excluded.size_bytes,
         sha256 = excluded.sha256,
         quantization = excluded.quantization,
         is_lfs = excluded.is_lfs,
         runnable = excluded.runnable,
         id = excluded.id`
    );

    const write = this.database.transaction((items: ModelArtifact[]) => {
      for (const artifact of items) {
        statement.run({
          id: artifact.id,
          modelId: artifact.modelId,
          revision: artifact.revision,
          path: artifact.path,
          format: artifact.format,
          quantization: artifact.quantization,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          isLfs: artifact.isLfs ? 1 : 0,
          runnable: artifact.runnable ? 1 : 0
        });
      }
    });

    write(artifacts);
  }
}

function toModel(row: CatalogueRow): CatalogueModel {
  const tags = safeParseTags(row.tags_json);

  return {
    id: row.id,
    author: row.author,
    name: row.name,
    license: row.license,
    pipelineTag: row.pipeline_tag,
    parameterCount: row.parameter_count,
    contextWindow: row.context_window,
    downloads: row.downloads,
    likes: row.likes,
    gated: row.gated,
    lastModifiedAt: row.last_modified_at,
    tags,
    capabilities: deriveCapabilities(tags, row.context_window),
    cachedAt: row.cached_at
  };
}

function safeParseTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
