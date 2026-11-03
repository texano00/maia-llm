import { CURRENCY, type Estimate } from "@maia/contracts";

export interface EstimateOffer {
  gpuName: string;
  gpuRamGb: number;
  hourlyRateMicroUsd: number;
  expectedWaitMinutes: number;
}

export interface EstimateInput {
  id: string;
  modelId: string;
  offer: EstimateOffer;
  expectedMinutes: number;
  now: Date;
  simulated: boolean;
}

/** vast.ai bills per second but applies a minimum charge; state it explicitly. */
export const MINIMUM_BILLABLE_MINUTES = 5;

/**
 * Builds the pre-session estimate shown before anything chargeable exists
 * (FR-007, FR-016). Values are deliberately conservative and every assumption
 * that changes the number is listed for the user.
 */
export function buildEstimate(input: EstimateInput): Estimate {
  const expectedMinutes = Math.max(input.expectedMinutes, MINIMUM_BILLABLE_MINUTES);
  const hourly = input.offer.hourlyRateMicroUsd;

  const projectedTotalMicroUsd = ceilUsd((hourly * expectedMinutes) / 60);
  const low = ceilUsd((hourly * MINIMUM_BILLABLE_MINUTES) / 60);
  const high = ceilUsd(projectedTotalMicroUsd * 1.6);

  return {
    id: input.id,
    modelId: input.modelId,
    createdAt: input.now.toISOString(),
    gpuName: input.offer.gpuName,
    gpuRamGb: input.offer.gpuRamGb,
    hourlyRateMicroUsd: hourly,
    minimumMinutes: MINIMUM_BILLABLE_MINUTES,
    expectedMinutes,
    projectedTotalMicroUsd,
    rangeMicroUsd: { low, high: Math.max(high, projectedTotalMicroUsd) },
    waitMinutes: {
      low: 0,
      high: Math.ceil(input.offer.expectedWaitMinutes * 2)
    },
    currency: CURRENCY,
    assumptions: [
      `Billed per second with a ${MINIMUM_BILLABLE_MINUTES}-minute minimum`,
      `Assumes the session runs for about ${expectedMinutes} minutes`,
      "Model download and container start-up time are included in GPU time",
      "Storage and egress charges from the provider are not included"
    ],
    notes: [
      "Provider fees, taxes, and currency conversion may vary from this estimate.",
      input.simulated
        ? "Simulated GPU: this run is free and exists to exercise the flow."
        : "Only GPU time is charged; the app releases the instance when you stop."
    ],
    simulated: input.simulated
  };
}

function ceilUsd(value: number): number {
  return Math.max(1, Math.ceil(value));
}

export function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}
