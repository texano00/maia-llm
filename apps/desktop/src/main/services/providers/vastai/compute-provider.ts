import type { GpuFilters } from "@maia/contracts";
import type { ComputeOffer, ComputeProvider } from "../../sessions/orchestrator";
import {
  buildSearchQuery,
  estimateGpuRamGb,
  readMappedPort,
  readPublicHost,
  toComputeOffer,
  VastAiClient
} from "./client";

export interface VastComputeProviderOptions {
  getApiKey: () => Promise<string | undefined>;
  getParameterCount: (modelId: string) => Promise<number | null>;
  getHfToken?: () => Promise<string | undefined>;
  getFilters?: () => GpuFilters | undefined;
  containerImage?: string;
  diskGb?: number;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  logger?: { info(message: string, context?: Record<string, unknown>): void; warn(message: string, context?: Record<string, unknown>): void } | undefined;
}

interface InstanceEndpoint {
  host: string;
  port: number;
}

/**
 * Real vast.ai provisioning. Instances are created from the chosen offer with a
 * vLLM container, labelled `maia:<install>:<session>`, and destroyed on teardown.
 */
export function createVastComputeProvider(options: VastComputeProviderOptions): ComputeProvider & {
  resolveEndpoint(instanceId: number): InstanceEndpoint | null;
} {
  const endpoints = new Map<number, InstanceEndpoint>();

  async function client(): Promise<VastAiClient> {
    const key = await options.getApiKey();
    if (!key) {
      throw new Error("Add your vast.ai API key in Settings before renting a GPU.");
    }

    return new VastAiClient(key);
  }

  return {
    resolveEndpoint(instanceId: number): InstanceEndpoint | null {
      return endpoints.get(instanceId) ?? null;
    },

    async findOffer({ modelId, filters }): Promise<ComputeOffer | null> {
      const api = await client();
      const parameterCount = await options.getParameterCount(modelId);
      const gpuRamGb = estimateGpuRamGb(parameterCount);
      const effectiveFilters = filters ?? options.getFilters?.();

      const offers = await api.searchOffers(
        buildSearchQuery({
          gpu_ram_gb: gpuRamGb,
          maxHourlyMicroUsd: effectiveFilters?.maxHourlyMicroUsd ?? null,
          filters: effectiveFilters
        })
      );

      const mapped = offers
        .map(toComputeOffer)
        .filter((offer): offer is ComputeOffer => offer !== null)
        .sort((left, right) => left.hourlyRateMicroUsd - right.hourlyRateMicroUsd);

      const [best] = mapped;
      options.logger?.info("vast.ai offer search finished", {
        modelId,
        gpuRamGb,
        candidates: mapped.length
      });

      return best ?? null;
    },

    async createInstance(offer, context) {
      const api = await client();
      const hfToken = await options.getHfToken?.();

      const instanceId = await api.createInstance({
        offerId: offer.offerId,
        image: options.containerImage ?? "vllm/vllm-openai:latest",
        diskGb: options.diskGb ?? 64,
        label: context.label,
        env: hfToken ? { HUGGING_FACE_HUB_TOKEN: hfToken } : {},
        args: ["-p", "8000:8000", "--model", context.modelId, "--port", "8000"]
      });

      options.logger?.info("vast.ai instance requested", { instanceId, offerId: offer.offerId });
      return { instanceId };
    },

    async waitUntilReady(instanceId, timeoutMs) {
      const api = await client();
      const deadline = Date.now() + (options.readyTimeoutMs ?? timeoutMs);
      const pollInterval = options.pollIntervalMs ?? 5_000;

      for (;;) {
        const instance = await api.getInstance(instanceId);
        const status = instance.actual_status;

        if (status === "running") {
          const host = readPublicHost(instance);
          const port = readMappedPort(instance);
          if (host && port) {
            endpoints.set(instanceId, { host, port });
            const healthy = await waitForHealth(`http://${host}:${port}`, deadline, options.fetchImpl);
            if (!healthy) {
              throw new Error("The model server did not become ready in time. The GPU was released.");
            }
            return;
          }
        }

        if (status === "exited" || status === "error" || status === "destroyed") {
          throw new Error(`The GPU instance stopped while starting up (${status}).`);
        }

        if (Date.now() > deadline) {
          throw new Error("Timed out waiting for the GPU instance to start.");
        }

        await sleep(pollInterval);
      }
    },

    async destroyInstance(instanceId) {
      endpoints.delete(instanceId);
      const api = await client();
      await api.destroyInstance(instanceId);
    }
  };
}

async function waitForHealth(
  baseUrl: string,
  deadline: number,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  for (;;) {
    try {
      const response = await fetchImpl(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000)
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // Model servers reject connections until vLLM finished loading weights.
    }

    if (Date.now() > deadline) {
      return false;
    }

    await sleep(5_000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
