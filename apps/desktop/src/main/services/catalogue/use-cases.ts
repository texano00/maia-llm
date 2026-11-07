import type { UseCaseCard } from "@maia/contracts";
import type { CatalogueService } from "./service";

/** What the portal publishes for basic mode. */
export interface CuratedUseCase {
  id: string;
  title: string;
  description: string;
  imageUrl: string | null;
  models: string[];
}

export interface UseCaseResolverOptions {
  /** Null when the app is not talking to a portal: basic mode has no cards. */
  list: (() => Promise<CuratedUseCase[]>) | null;
  catalogue: CatalogueService;
  logger?: { warn(message: string, context?: Record<string, unknown>): void } | undefined;
}

/**
 * Resolves each curated list to one runnable model.
 *
 * The order in the list is the product decision, so the first entry that the
 * snapshot marks supported wins. Unsupported entries are skipped individually —
 * one delisted mirror must not sink a whole card — and a card with nothing left
 * explains itself instead of disappearing.
 */
export function createUseCaseResolver(options: UseCaseResolverOptions): () => Promise<UseCaseCard[]> {
  return async () => {
    if (!options.list) {
      return [];
    }

    let curated: CuratedUseCase[];
    try {
      // Loading the catalogue first is what fills the support map; without it
      // every entry would look unknown.
      await options.catalogue.search({ limit: 100 });
      curated = await options.list();
    } catch (error) {
      options.logger?.warn("Could not resolve basic-mode use cases", {
        message: error instanceof Error ? error.message : String(error)
      });
      return [];
    }

    return curated.map((useCase) => resolveOne(useCase, options.catalogue));
  };
}

function resolveOne(useCase: CuratedUseCase, catalogue: CatalogueService): UseCaseCard {
  const rejected: string[] = [];

  for (const modelId of useCase.models) {
    const model = catalogue.get(modelId);
    if (!model) {
      rejected.push(`${modelId} is not in the current catalogue`);
      continue;
    }

    const support = catalogue.supportFor(modelId);
    if (!support) {
      // No verdict (not a snapshot source): trust the listed order.
      return card(useCase, model.id, model.name, null);
    }

    if (support.supported) {
      return card(useCase, model.id, model.name, null);
    }

    rejected.push(support.reason ?? `${modelId} cannot be served`);
  }

  return card(
    useCase,
    null,
    null,
    rejected.length === 0
      ? "This use case has no models yet."
      : `Nothing here can run yet: ${rejected[0]}`
  );
}

function card(
  useCase: CuratedUseCase,
  modelId: string | null,
  modelName: string | null,
  reason: string | null
): UseCaseCard {
  return {
    id: useCase.id,
    title: useCase.title,
    description: useCase.description,
    imageUrl: useCase.imageUrl,
    modelId,
    modelName,
    reason
  };
}
