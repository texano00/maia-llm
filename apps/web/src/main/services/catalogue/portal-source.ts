import { z } from "zod";
import type { CatalogueModel, CatalogueSnapshotInfo, ModelArtifact } from "@maia/contracts";
import type { CatalogueSource } from "./service";
import type { CatalogueSupport } from "./service";

/**
 * The catalogue as the portal publishes it.
 *
 * The Hub knows what exists; only the backend knows what can run — engine,
 * loadability and chat template are its verdicts, and they are what "Only models I
 * can run" has to believe. Listing the Hub directly gave every row an empty
 * verdict, so the filter either hid the world or showed models that fail at start.
 *
 * The snapshot is one document with an ETag, so a poll costs a `304`. When the
 * portal has no snapshot yet, `listResolved` returns null and the caller falls back
 * to the Hub listing.
 */

const artifactSchema = z.object({
  path: z.string(),
  sizeBytes: z.number().optional(),
  format: z.string().optional(),
  quantization: z.string().nullable().optional(),
  sha256: z.string().nullable().optional()
});

const modelSchema = z.object({
  id: z.string().min(1),
  author: z.string().optional(),
  name: z.string().optional(),
  license: z.string().nullable().optional(),
  pipelineTag: z.string().nullable().optional(),
  parameterCount: z.number().nullable().optional(),
  contextWindow: z.number().nullable().optional(),
  downloads: z.number().optional(),
  likes: z.number().optional(),
  gated: z.string().optional(),
  lastModifiedAt: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  capabilities: z.array(z.string()).optional(),
  artifacts: z.array(artifactSchema).optional(),
  engine: z.enum(["vllm", "llamacpp"]).nullable().optional(),
  supported: z.boolean().optional(),
  supportedReason: z.string().nullable().optional(),
  refreshedAt: z.string().optional()
});

const snapshotSchema = z.object({
  snapshot: z
    .object({
      version: z.number().optional(),
      refreshedAt: z.string().optional(),
      modelCount: z.number().optional()
    })
    .optional(),
  models: z.array(modelSchema)
});

export interface PortalCatalogueSourceOptions {
  /** `MAIA_PORTAL_URL`; a source without one cannot be built. */
  portalUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: { warn(message: string): void } | undefined;
}

export interface PortalCatalogueSource extends CatalogueSource {
  /** The published rows, with the backend's verdicts; null when unpublished. */
  listResolved(search: string, limit: number): Promise<CatalogueModel[] | null>;
  // Required here: a snapshot always has the answer, unlike a Hub listing.
  getSupport(id: string): CatalogueSupport | null;
  getArtifacts(id: string): ModelArtifact[];
  snapshotInfo(): CatalogueSnapshotInfo | null;
  /** The version the rows came from, for the "catalogue is N minutes old" line. */
  publishedInfo(): { version: number; refreshedAt: string; modelCount: number } | null;
}

export function createPortalCatalogueSource(
  options: PortalCatalogueSourceOptions
): PortalCatalogueSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.portalUrl.replace(/\/$/, "");

  let cache: {
    etag: string | null;
    models: CatalogueModel[];
    artifacts: Map<string, ModelArtifact[]>;
    info: { version: number; refreshedAt: string; modelCount: number } | null;
  } | null = null;

  /** One fetch at a time: the catalogue view polls while someone types. */
  let inFlight: Promise<void> | null = null;

  function toModel(entry: z.infer<typeof modelSchema>): CatalogueModel {
    return {
      id: entry.id,
      author: entry.author ?? entry.id.split("/")[0] ?? "unknown",
      name: entry.name ?? entry.id.split("/").at(-1) ?? entry.id,
      license: entry.license ?? null,
      pipelineTag: entry.pipelineTag ?? null,
      parameterCount: entry.parameterCount ?? null,
      contextWindow: entry.contextWindow ?? null,
      downloads: entry.downloads ?? 0,
      likes: entry.likes ?? 0,
      gated: (entry.gated as CatalogueModel["gated"]) ?? "none",
      lastModifiedAt: entry.lastModifiedAt ?? null,
      tags: entry.tags ?? [],
      capabilities: entry.capabilities ?? [],
      supported: entry.supported,
      supportedReason: entry.supportedReason ?? null,
      engine: entry.engine ?? null,
      cachedAt: entry.refreshedAt ?? new Date().toISOString()
    } as CatalogueModel;
  }

  async function load(): Promise<void> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (cache?.etag) {
      headers["if-none-match"] = cache.etag;
    }

    const response = await fetchImpl(`${base}/v1/config/catalogue`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (response.status === 304 && cache) {
      return;
    }
    if (response.status === 503) {
      // An unbuilt snapshot is not an outage: the caller falls back to the Hub.
      options.logger?.warn("catalogue: the portal has no snapshot yet, using the Hub listing");
      return;
    }
    if (!response.ok) {
      throw new Error(`the portal answered ${response.status} for the catalogue`);
    }

    const parsed = snapshotSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("the portal returned an unexpected catalogue");
    }

    const models = parsed.data.models.map(toModel);
    const artifacts = new Map<string, ModelArtifact[]>();
    for (const entry of parsed.data.models) {
      artifacts.set(
        entry.id,
        (entry.artifacts ?? []).map((artifact) => ({
          id: `${entry.id}:${artifact.path}`,
          modelId: entry.id,
          revision: "main",
          path: artifact.path,
          format: (artifact.format as ModelArtifact["format"]) ?? "other",
          quantization: artifact.quantization ?? null,
          sizeBytes: artifact.sizeBytes ?? 0,
          sha256: artifact.sha256 ?? null,
          isLfs: artifact.sizeBytes !== undefined,
          // The snapshot's artifacts are the weights it judged loadable.
          runnable: entry.supported === true
        }))
      );
    }

    const refreshedAt = parsed.data.snapshot?.refreshedAt ?? new Date().toISOString();
    cache = {
      etag: response.headers.get("etag"),
      models,
      artifacts,
      info: {
        version: parsed.data.snapshot?.version ?? 0,
        refreshedAt,
        modelCount: models.length
      }
    };
  }

  return {
    async listResolved(search, limit) {
      inFlight ??= load().finally(() => {
        inFlight = null;
      });
      try {
        await inFlight;
      } catch (error) {
        options.logger?.warn(
          `catalogue: ${error instanceof Error ? error.message : String(error)}`
        );
        return cache?.models ?? null;
      }

      if (!cache) {
        return null;
      }

      const term = search.trim().toLowerCase();
      const matching = term.length === 0
        ? cache.models
        : cache.models.filter(
            (model) =>
              model.id.toLowerCase().includes(term) ||
              model.name.toLowerCase().includes(term) ||
              model.author.toLowerCase().includes(term)
          );

      return matching.slice(0, limit);
    },

    // The payload-shaped API is not used when `listResolved` answers, but the
    // interface requires it: it returns nothing rather than pretending.
    async listModels() {
      return [];
    },

    async getModel(id) {
      const model = cache?.models.find((entry) => entry.id === id);
      if (!model) {
        throw new Error(`Unknown model: ${id}`);
      }

      return {
        model: {
          id: model.id,
          author: model.author,
          downloads: model.downloads,
          likes: model.likes,
          pipeline_tag: model.pipelineTag,
          lastModified: model.lastModifiedAt,
          tags: model.tags,
          gated: model.gated !== "none",
          cardData: model.license === null ? {} : { license: model.license }
        },
        files: []
      };
    },

    getSupport(id) {
      const model = cache?.models.find((entry) => entry.id === id);
      if (!model || typeof model.supported !== "boolean") {
        return null;
      }

      return {
        supported: model.supported,
        engine: model.engine ?? null,
        reason: model.supportedReason ?? null
      } satisfies CatalogueSupport;
    },

    getArtifacts(id) {
      return cache?.artifacts.get(id) ?? [];
    },

    snapshotInfo() {
      if (!cache?.info) {
        return null;
      }

      return {
        version: cache.info.version,
        refreshedAt: cache.info.refreshedAt,
        source: "portal" as const
      };
    },

    publishedInfo() {
      return cache?.info ?? null;
    }
  };
}
