import type { CatalogueModel } from "@maia/contracts";
import type { CatalogueSource } from "./service";
import type { PortalCatalogueSource } from "./portal-source";

/**
 * The published catalogue, with the Hub as the long tail.
 *
 * The snapshot is the only list that carries a verdict, so it answers first. It is
 * also finite, and a person may look for a repository it has never listed — a brand
 * new finetune, say. Those fall through to the Hub, which knows what exists but not
 * what runs: the rows arrive without a verdict, and the catalogue says so instead
 * of guessing. The start path still refuses what cannot boot, with its own reason.
 */
export interface CompositeCatalogueSourceOptions {
  portal: PortalCatalogueSource;
  hub: CatalogueSource;
}

export function createCompositeCatalogueSource(
  options: CompositeCatalogueSourceOptions
): CatalogueSource & Pick<PortalCatalogueSource, "listResolved"> {
  const { portal, hub } = options;

  return {
    async listResolved(search: string, limit: number): Promise<CatalogueModel[] | null> {
      const published = await portal.listResolved(search, limit);
      if (published === null) {
        // No snapshot at all: the Hub listing is all there is.
        return null;
      }
      if (published.length > 0) {
        return published;
      }

      // A term the snapshot does not know. `null` hands the search to the Hub.
      return search.trim().length > 0 ? null : published;
    },

    listModels: (request) => hub.listModels(request),
    getModel: (id) => hub.getModel(id),
    getChatTemplate: (id) => hub.getChatTemplate?.(id) ?? Promise.resolve(true),
    getSupport: (id) => portal.getSupport(id),
    getArtifacts: (id) => portal.getArtifacts(id),
    snapshotInfo: () => portal.snapshotInfo()
  };
}
