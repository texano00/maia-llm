import type { CatalogueModel, UseCaseCard } from "@maia/contracts";

/**
 * Basic-mode cards for a deployment whose curator has published none.
 *
 * The portal owns curation, but a catalogue full of runnable models and a screen
 * saying "no scenarios yet" is a dead end for the person who just signed in. These
 * are derived from what the catalogue can actually serve, so they are never a lie:
 * each card names a model the backend already marked supported.
 *
 * Curated cards always win. This is only what fills the gap when there are none,
 * and each one is a plain question ("the best model here", "the smallest one")
 * rather than invented editorial.
 */
export function deriveDefaultScenarios(models: readonly CatalogueModel[]): UseCaseCard[] {
  const runnable = models.filter((model) => model.supported === true);
  if (runnable.length === 0) {
    return [];
  }

  const used = new Set<string>();
  const cards: UseCaseCard[] = [];

  const take = (
    id: string,
    title: string,
    description: string,
    select: (pool: CatalogueModel[]) => CatalogueModel | undefined,
    // A capability card is a different question about the same model, so it may
    // point at one an earlier card already named — a single small multimodal model
    // really is both "small and quick" and "can read images". The generic
    // "best"/"smallest"/"longest" cards never repeat each other.
    allowReuse = false
  ): void => {
    const pool = runnable.filter((candidate) => allowReuse || !used.has(candidate.id));
    const model = select(pool);
    if (!model) {
      return;
    }

    used.add(model.id);
    cards.push({
      id: `default-${id}`,
      title,
      description,
      imageUrl: null,
      modelId: model.id,
      modelName: model.name || model.id,
      reason: null
    });
  };

  take(
    "best",
    "The best model available",
    "The most downloaded model this catalogue can actually run. A safe first choice.",
    (pool) => pool[0]
  );

  take(
    "small",
    "Something small and quick",
    "The smallest runnable model here: fast to boot, cheap to keep, good for short answers.",
    (pool) =>
      pool
        .filter((model) => typeof model.parameterCount === "number" && model.parameterCount > 0)
        .sort((a, b) => (a.parameterCount ?? 0) - (b.parameterCount ?? 0))[0]
  );

  take(
    "code",
    "Help with code",
    "A runnable model that advertises code ability. Paste a file and ask what it does.",
    (pool) => pool.find((model) => model.capabilities.includes("code")),
    true
  );

  take(
    "vision",
    "Look at a picture",
    "A runnable model that can read images. Attach a screenshot and ask about it.",
    (pool) => pool.find((model) => model.capabilities.includes("vision")),
    true
  );

  take(
    "context",
    "Read something long",
    "The runnable model with the largest context window here, for long documents.",
    (pool) =>
      pool
        .filter((model) => typeof model.contextWindow === "number" && model.contextWindow > 0)
        .sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0))[0]
  );

  return cards;
}
