import type { ModelArtifact } from "@maia/contracts";
import type { CatalogueSource, CatalogueSupport, CatalogueSnapshotInfo } from "./service";
import type { HuggingFaceModelPayload, HuggingFaceTreeEntry } from "./mapper";
import type { PortalCatalogue, PortalCatalogueModel, PortalClient } from "../portal/client";

export interface PortalCatalogueSource extends CatalogueSource {
  /** Verdicts and artifacts are already mapped: do not re-derive them. */
  getArtifacts(id: string): ModelArtifact[];
  snapshotInfo(): CatalogueSnapshotInfo | null;
}

/**
 * Turns the portal payload back into the shape the desktop pipeline expects.
 *
 * The catalogue service, the SQLite cache and the renderer all work on Hub
 * payloads today; feeding them the snapshot keeps one mapping path instead of
 * two. What the Hub cannot tell us — engine and support verdict — travels
 * alongside, in the same in-memory snapshot the models came from.
 */
export function createPortalCatalogueSource(options: { client: PortalClient }): PortalCatalogueSource {
  let snapshot: PortalCatalogue | null = null;
  let loading: Promise<PortalCatalogue> | null = null;

  async function load(force = false): Promise<PortalCatalogue> {
    if (snapshot && !force) {
      return snapshot;
    }
    if (loading) {
      return loading;
    }

    loading = options.client
      .catalogue()
      .then((payload) => {
        snapshot = payload;
        return payload;
      })
      .finally(() => {
        loading = null;
      });

    return loading;
  }

  function find(id: string): PortalCatalogueModel | null {
    return snapshot?.models.find((model) => model.id === id) ?? null;
  }

  async function findOrLoad(id: string): Promise<PortalCatalogueModel | null> {
    const known = find(id);
    if (known) {
      return known;
    }

    await load(true);
    return find(id);
  }

  return {
    async listModels() {
      // The snapshot is a fixed, backend-curated page: searching it is a local
      // filter (`filterAndSort`), and fetching the Hub is exactly what this
      // source exists to avoid.
      const payload = await load();
      return payload.models.map(toHubPayload);
    },

    async getModel(id) {
      const model = await findOrLoad(id);
      if (!model) {
        throw new Error(`Model ${id} is not in the current catalogue snapshot.`);
      }

      return { model: toHubPayload(model), files: toTreeEntries(model) };
    },

    getArtifacts(id) {
      const model = find(id);
      return model ? toArtifacts(model) : [];
    },

    getSupport(id) {
      const model = find(id);
      if (!model) {
        return null;
      }

      return {
        supported: model.supported,
        engine: model.engine,
        reason: model.supportedReason
      } satisfies CatalogueSupport;
    },

    snapshotInfo() {
      if (!snapshot) {
        return null;
      }

      return {
        version: snapshot.snapshot.version,
        refreshedAt: snapshot.snapshot.refreshedAt,
        source: "portal" as const
      };
    }
  };
}

export function toHubPayload(model: PortalCatalogueModel): HuggingFaceModelPayload {
  return {
    id: model.id,
    author: model.author,
    downloads: model.downloads,
    likes: model.likes,
    gated: model.gated === "none" ? false : model.gated,
    pipeline_tag: model.pipelineTag,
    lastModified: model.lastModifiedAt,
    tags: model.tags,
    cardData: {
      ...(model.license !== null ? { license: model.license } : {}),
      ...(model.contextWindow !== null ? { context_length: model.contextWindow } : {})
    },
    // `sumParameters` adds the per-component counts; one `total` entry keeps the
    // snapshot's parameter count intact.
    safetensors: model.parameterCount !== null ? { parameters: { total: model.parameterCount } } : null,
    gguf:
      model.parameterCount !== null && model.contextWindow !== null
        ? { total: model.parameterCount, context_length: model.contextWindow }
        : null
  };
}

function toTreeEntries(model: PortalCatalogueModel): HuggingFaceTreeEntry[] {
  return model.artifacts.map((artifact) => ({
    type: "file" as const,
    path: artifact.path,
    size: artifact.sizeBytes,
    lfs: artifact.sha256 ? { sha256: artifact.sha256, size: artifact.sizeBytes } : null
  }));
}

function toArtifacts(model: PortalCatalogueModel): ModelArtifact[] {
  return model.artifacts.map((artifact) => ({
    id: `${model.id}@main:${artifact.path}`,
    modelId: model.id,
    revision: "main",
    path: artifact.path,
    format: artifact.format,
    quantization: artifact.quantization,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    isLfs: artifact.sha256 !== null,
    runnable: artifact.format !== "other" && artifact.sizeBytes > 0
  }));
}
