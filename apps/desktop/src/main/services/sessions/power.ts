import { DEFAULT_GPU_FILTERS, type GpuFilters, type PowerTier } from "@maia/contracts";

export interface TierProfile {
  label: string;
  /** Reliability floor applied on top of the user's own preferences. */
  minReliability: number | null;
  /** Speed factor applied to the measured/default base rate. */
  speedFactor: number;
}

/**
 * The three stops of the catalogue power slider. Economy drops the reliability
 * floor (cheapest offer wins), Balanced keeps a sane floor, Performance asks for
 * the most reliable offers and projects a higher output rate.
 */
export const POWER_TIER_PROFILES: Record<PowerTier, TierProfile> = {
  economy: { label: "Economy", minReliability: null, speedFactor: 0.7 },
  balanced: { label: "Balanced", minReliability: 0.95, speedFactor: 1 },
  performance: { label: "Performance", minReliability: 0.98, speedFactor: 1.4 }
};

export const POWER_TIER_ORDER: readonly PowerTier[] = ["economy", "balanced", "performance"];
export const DEFAULT_POWER_TIER: PowerTier = "balanced";

/** Base output rate used before any measured run exists for a model. */
export const DEFAULT_BASE_TOKENS_PER_SECOND = 40;

/** Tier filters never loosen what the user configured; they only tighten it. */
export function tierFilters(base: GpuFilters | undefined, tier: PowerTier): GpuFilters | undefined {
  const profile = POWER_TIER_PROFILES[tier];
  if (profile.minReliability === null) {
    return base;
  }

  const filters = base ?? DEFAULT_GPU_FILTERS;
  return {
    ...filters,
    minReliability: Math.max(filters.minReliability ?? 0, profile.minReliability)
  };
}

export interface SpeedProjection {
  value: number;
  source: "measured" | "default";
  sampleCount: number;
}

/**
 * Median measured rate when at least three runs exist, otherwise a coarse
 * default. Either way the tier factor applies, and the UI labels the source.
 */
export function projectTokensPerSecond(samples: number[], tier: PowerTier): SpeedProjection {
  const valid = samples.filter((value) => Number.isFinite(value) && value > 0);
  const factor = POWER_TIER_PROFILES[tier].speedFactor;

  if (valid.length >= 3) {
    const sorted = [...valid].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;

    return { value: round1(median * factor), source: "measured", sampleCount: valid.length };
  }

  return { value: round1(DEFAULT_BASE_TOKENS_PER_SECOND * factor), source: "default", sampleCount: valid.length };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
