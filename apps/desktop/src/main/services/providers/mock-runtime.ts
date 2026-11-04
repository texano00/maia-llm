import type { GpuFilters } from "@maia/contracts";
import type { ComputeOffer, ComputeProvider, InferenceRuntime, StreamKind } from "../sessions/orchestrator";

/**
 * Deterministic stand-ins used while `MAIA_PROVIDER_MODE=mock`, so the whole
 * estimate → provision → chat → teardown flow can be exercised without spending
 * money or holding credentials.
 */
export interface MockOffer extends ComputeOffer {
  datacenter: string;
  reliability: number;
}

export const MOCK_OFFERS: MockOffer[] = [
  {
    offerId: 1,
    machineId: 9001,
    gpuName: "Mock RTX 4090",
    gpuRamGb: 24,
    hourlyRateMicroUsd: 440_000,
    expectedWaitMinutes: 1,
    simulated: true,
    datacenter: "trusted-it-1",
    reliability: 0.99
  },
  {
    offerId: 2,
    machineId: 9002,
    gpuName: "Mock A100 40GB",
    gpuRamGb: 40,
    hourlyRateMicroUsd: 890_000,
    expectedWaitMinutes: 3,
    simulated: true,
    datacenter: "community-de-2",
    reliability: 0.93
  },
  {
    offerId: 3,
    machineId: 9003,
    gpuName: "Mock L40S",
    gpuRamGb: 48,
    hourlyRateMicroUsd: 760_000,
    expectedWaitMinutes: 6,
    simulated: true,
    datacenter: "trusted-us-4",
    reliability: 0.97
  }
];

export const MOCK_OFFER = MOCK_OFFERS[0]!;

export interface MockComputeOptions {
  provisionDelayMs?: number;
  offer?: ComputeOffer;
}

/** Datacenter ids are `provider-country-index`, so the country is the middle segment. */
export function countryOf(datacenter: string): string {
  const parts = datacenter.split("-");
  return (parts[1] ?? "").slice(0, 2).toUpperCase();
}

export function createMockComputeProvider(options: MockComputeOptions = {}): ComputeProvider & {
  destroyed: number[];
} {
  const destroyed: number[] = [];
  let nextInstanceId = 1000;

  return {
    destroyed,

    async findOffer({ filters, excludeOfferIds }) {
      if (options.offer) {
        return options.offer;
      }

      const excluded = new Set(excludeOfferIds ?? []);
      return pickOffer(
        filters,
        MOCK_OFFERS.filter((offer) => !excluded.has(offer.offerId))
      );
    },

    async createInstance() {
      nextInstanceId += 1;
      return { instanceId: nextInstanceId };
    },
    async waitUntilReady() {
      if (options.provisionDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.provisionDelayMs));
      }
    },

    async destroyInstance(instanceId: number) {
      destroyed.push(instanceId);
    }
  };
}

/**
 * Applies the user's opt-in GPU filters, then ranks by price with reliability as
 * a tiebreaker. No filters means every offer is eligible.
 */
export function pickOffer(
  filters: GpuFilters | undefined,
  offers: MockOffer[] = MOCK_OFFERS
): ComputeOffer | null {
  const eligible = offers.filter((offer) => {
    if (!filters) {
      return true;
    }

    if (
      filters.countries.length > 0 &&
      !filters.countries.map((country) => country.toUpperCase()).includes(countryOf(offer.datacenter))
    ) {
      return false;
    }
    if (
      filters.datacenters.length > 0 &&
      !filters.datacenters.some((entry) => offer.datacenter.toLowerCase().includes(entry.toLowerCase()))
    ) {
      return false;
    }
    if (filters.minReliability !== null && offer.reliability < filters.minReliability) {
      return false;
    }
    if (filters.maxHourlyMicroUsd !== null && offer.hourlyRateMicroUsd > filters.maxHourlyMicroUsd) {
      return false;
    }

    return true;
  });

  const [best] = [...eligible].sort(
    (left, right) =>
      left.hourlyRateMicroUsd - right.hourlyRateMicroUsd || right.reliability - left.reliability
  );

  return best ?? null;
}

export interface MockInferenceOptions {
  chunkDelayMs?: number;
  response?: string;
  reasoning?: string;
}

export function createMockInference(options: MockInferenceOptions = {}): InferenceRuntime {
  const reasoning =
    options.reasoning ??
    "Considering the request, checking the available context, and planning a concise answer.";
  const response =
    options.response ??
    "This is a simulated reply from the mock runtime. Provisioning, streaming, token accounting, and teardown all run for real; only the GPU is replaced by a fixture.";

  return {
    async stream({ prompt, signal, onDelta }) {
      for (const word of reasoning.split(" ")) {
        if (signal.aborted) {
          throw new Error("Generation cancelled");
        }
        onDelta("reasoning", `${word} `);
        if (options.chunkDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.chunkDelayMs));
        }
      }

      let text = "";
      for (const word of response.split(" ")) {
        if (signal.aborted) {
          throw new Error("Generation cancelled");
        }

        const piece = `${text.length > 0 ? " " : ""}${word}`;
        text += piece;
        onDelta("content" satisfies StreamKind, piece);

        if (options.chunkDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.chunkDelayMs));
        }
      }

      return {
        tokens: Math.max(1, Math.ceil((text.length + prompt.length + reasoning.length) / 4)),
        text
      };
    }
  };
}
