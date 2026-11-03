import type { ComputeOffer, ComputeProvider, InferenceRuntime } from "../sessions/orchestrator";

/**
 * Deterministic stand-ins used while `MAIA_PROVIDER_MODE=mock`, so the whole
 * estimate → provision → chat → teardown flow can be exercised without spending
 * money or holding credentials.
 */
export const MOCK_OFFER: ComputeOffer = {
  offerId: 1,
  gpuName: "Mock RTX 4090",
  gpuRamGb: 24,
  hourlyRateMicroUsd: 440_000,
  expectedWaitMinutes: 1,
  simulated: true
};

export interface MockComputeOptions {
  provisionDelayMs?: number;
  offer?: ComputeOffer;
}

export function createMockComputeProvider(options: MockComputeOptions = {}): ComputeProvider & {
  destroyed: number[];
} {
  const destroyed: number[] = [];
  let nextInstanceId = 1000;

  return {
    destroyed,

    async findOffer() {
      return options.offer ?? MOCK_OFFER;
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

export interface MockInferenceOptions {
  chunkDelayMs?: number;
  response?: string;
}

export function createMockInference(options: MockInferenceOptions = {}): InferenceRuntime {
  const response =
    options.response ??
    "This is a simulated reply from the mock runtime. Provisioning, streaming, token accounting, and teardown all run for real; only the GPU is replaced by a fixture.";

  return {
    async stream({ prompt, signal, onDelta }) {
      const words = response.split(" ");
      let text = "";

      for (const word of words) {
        if (signal.aborted) {
          throw new Error("Generation cancelled");
        }

        const piece = `${text.length > 0 ? " " : ""}${word}`;
        text += piece;
        onDelta(piece);

        if (options.chunkDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.chunkDelayMs));
        }
      }

      return { tokens: Math.max(1, Math.ceil((text.length + prompt.length) / 4)), text };
    }
  };
}
