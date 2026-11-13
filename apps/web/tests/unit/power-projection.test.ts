import { describe, expect, it } from "vitest";
import { DEFAULT_GPU_FILTERS, type GpuFilters } from "@maia/contracts";
import {
  DEFAULT_BASE_TOKENS_PER_SECOND,
  POWER_TIER_PROFILES,
  projectTokensPerSecond,
  tierFilters
} from "../../src/main/services/sessions/power";

describe("power tiers", () => {
  it("tightens the reliability floor as power increases", () => {
    const base: GpuFilters = { ...DEFAULT_GPU_FILTERS, minReliability: 0.9 };

    expect(tierFilters(base, "economy")).toEqual(base);
    expect(tierFilters(base, "balanced")?.minReliability).toBe(0.95);
    expect(tierFilters(base, "performance")?.minReliability).toBe(0.98);
  });

  it("never loosens a stricter user preference", () => {
    const strict: GpuFilters = { ...DEFAULT_GPU_FILTERS, minReliability: 0.99 };

    expect(tierFilters(strict, "balanced")?.minReliability).toBe(0.99);
  });

  it("uses a labelled default until three measured runs exist", () => {
    const none = projectTokensPerSecond([], "balanced");
    const two = projectTokensPerSecond([30, 50], "balanced");

    expect(none).toEqual({ value: DEFAULT_BASE_TOKENS_PER_SECOND, source: "default", sampleCount: 0 });
    expect(two.source).toBe("default");
  });

  it("projects from the median once measurements exist", () => {
    const projection = projectTokensPerSecond([10, 30, 50, 70], "balanced");

    expect(projection.source).toBe("measured");
    expect(projection.sampleCount).toBe(4);
    expect(projection.value).toBe(40);
  });

  it("scales with the tier factor and keeps the order monotonic", () => {
    const samples = [10, 20, 30];
    const economy = projectTokensPerSecond(samples, "economy").value;
    const balanced = projectTokensPerSecond(samples, "balanced").value;
    const performance = projectTokensPerSecond(samples, "performance").value;

    expect(balanced).toBe(20);
    expect(economy).toBeLessThan(balanced);
    expect(performance).toBeGreaterThan(balanced);
    expect(POWER_TIER_PROFILES.performance.speedFactor).toBeGreaterThan(
      POWER_TIER_PROFILES.balanced.speedFactor
    );
  });
});
