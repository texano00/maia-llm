import { z } from "zod";
import type { UseCaseCard } from "@maia/contracts";

/**
 * The curated basic-mode cards, read from the portal.
 *
 * The portal owns the curation: an operator edits the list in the backoffice, and
 * every installation — browser or desktop — shows the same thing. The portal
 * publishes the *intent* (`models` is the ordered list the curator picked) and
 * this side decides which entry can actually run, because only the product knows
 * what its catalogue currently supports.
 *
 * Basic mode used to render an empty grid on every deployment, because nothing
 * ever registered this channel: the only answer was an empty array, which the
 * renderer read as "there is nothing here" and bounced back to the full list.
 */

const portalUseCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string(),
  imageUrl: z.string().nullable().optional(),
  position: z.number().optional(),
  models: z.array(z.string()).default([])
});

const portalUseCasesSchema = z.object({
  useCases: z.array(portalUseCaseSchema)
});

export interface UseCaseReaderOptions {
  /** `MAIA_PORTAL_URL`; absent means nothing is curated as far as this build knows. */
  portalUrl: string | null;
  /** Resolves one id against the local catalogue. */
  resolve: (modelId: string) => {
    name: string;
    supported: boolean;
    reason: string | null;
  } | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** How long an answer is reused; the backoffice edits are not per-request news. */
  ttlMs?: number;
  now?: () => number;
  logger?: { warn(message: string): void };
}

export interface UseCaseReader {
  list(): Promise<UseCaseCard[]>;
}

const DEFAULT_TTL_MS = 60_000;

export function createPortalUseCaseReader(options: UseCaseReaderOptions): UseCaseReader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());

  let cached: { at: number; cards: UseCaseCard[] } | null = null;
  let inFlight: Promise<UseCaseCard[]> | null = null;

  async function fetchCards(): Promise<UseCaseCard[]> {
    const base = options.portalUrl?.replace(/\/$/, "");
    if (!base) {
      return [];
    }

    const response = await fetchImpl(`${base}/v1/config/use-cases`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      throw new Error(`the portal answered ${response.status} for use cases`);
    }

    const parsed = portalUseCasesSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("the portal returned an unexpected use-case list");
    }

    return parsed.data.useCases
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((useCase) => {
        // The first curated model this deployment can actually run wins; a card
        // whose models are all unusable stays visible and says why, because
        // hiding it would silently lose the curator's intent.
        const runnable = useCase.models
          .map((modelId) => ({ modelId, entry: options.resolve(modelId) }))
          .find((candidate) => candidate.entry?.supported === true);

        return {
          id: useCase.id,
          title: useCase.title,
          description: useCase.description,
          imageUrl: useCase.imageUrl ?? null,
          modelId: runnable?.modelId ?? null,
          modelName: runnable?.entry?.name ?? null,
          reason:
            runnable === undefined
              ? useCase.models.length === 0
                ? "No model is attached to this scenario yet."
                : (useCase.models
                    .map((modelId) => options.resolve(modelId)?.reason ?? null)
                    .find((reason) => reason !== null) ??
                  "None of this scenario's models can run on this catalogue.")
              : null
        } satisfies UseCaseCard;
      });
  }

  return {
    async list() {
      const at = now();
      if (cached && at - cached.at < ttlMs) {
        return cached.cards;
      }

      // One fetch at a time: the catalogue page asks on every render.
      inFlight ??= fetchCards()
        .then((cards) => {
          cached = { at: now(), cards };
          return cards;
        })
        .catch((error: unknown) => {
          // A portal outage must not empty the page that was working a minute
          // ago; the previous answer keeps serving.
          options.logger?.warn(
            `use cases unavailable: ${error instanceof Error ? error.message : String(error)}`
          );
          return cached?.cards ?? [];
        })
        .finally(() => {
          inFlight = null;
        });

      return inFlight;
    }
  };
}
