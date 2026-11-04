import type { GpuFilters } from "@maia/contracts";
import type { ComputeOffer, ComputeProvider } from "../../sessions/orchestrator";
import {
  buildSearchQuery,
  classifyOffer,
  estimateDiskGb,
  estimateGpuRamGb,
  isOfferUnavailableError,
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
  /** Overrides the disk size derived from the model size. */
  diskGb?: number;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a live client built from the stored key. */
  clientFactory?: (apiKey: string) => VastAiClient;
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

    return options.clientFactory ? options.clientFactory(key) : new VastAiClient(key);
  }

  return {
    resolveEndpoint(instanceId: number): InstanceEndpoint | null {
      return endpoints.get(instanceId) ?? null;
    },

    isOfferUnavailable(error: unknown): boolean {
      return isOfferUnavailableError(error);
    },

    async findOffer({ modelId, filters, excludeOfferIds }): Promise<ComputeOffer | null> {
      const api = await client();
      const parameterCount = await options.getParameterCount(modelId);
      const gpuRamGb = estimateGpuRamGb(parameterCount);
      const diskGb = options.diskGb ?? estimateDiskGb(parameterCount);
      const effectiveFilters = filters ?? options.getFilters?.();
      const excluded = new Set(excludeOfferIds ?? []);

      const offers = await api.searchOffers(
        buildSearchQuery({
          gpu_ram_gb: gpuRamGb,
          maxHourlyMicroUsd: effectiveFilters?.maxHourlyMicroUsd ?? null,
          filters: effectiveFilters,
          minDiskGb: diskGb
        })
      );

      // Offers whose machine is not rentable stay listed but cannot be booked;
      // asking for one answers `400 no_such_ask`. Slow hosts are dropped by the
      // configured startup gates, and Volta cards cannot run vLLM at all.
      const verdicts = new Map(offers.map((offer) => [offer.id, classifyOffer(offer, effectiveFilters)]));
      const bookable = offers.filter((offer) => verdicts.get(offer.id) === "bookable");
      const rejected = { notRentable: 0, unsupportedCapability: 0, tooSlow: 0 };
      for (const verdict of verdicts.values()) {
        if (verdict === "not-rentable") rejected.notRentable += 1;
        if (verdict === "unsupported-capability") rejected.unsupportedCapability += 1;
        if (verdict === "too-slow") rejected.tooSlow += 1;
      }

      const reliability = new Map(bookable.map((offer) => [offer.id, offer.reliability2 ?? 0]));
      const mapped = bookable
        .map(toComputeOffer)
        .filter((offer): offer is ComputeOffer => offer !== null)
        .filter((offer) => !excluded.has(offer.offerId))
        .sort(
          (left, right) =>
            left.hourlyRateMicroUsd - right.hourlyRateMicroUsd ||
            (reliability.get(right.offerId) ?? 0) - (reliability.get(left.offerId) ?? 0)
        );

      const [best] = mapped;
      options.logger?.info("vast.ai offer search finished", {
        modelId,
        gpuRamGb,
        diskGb,
        listed: offers.length,
        bookable: bookable.length,
        rejected,
        excluded: excluded.size,
        candidates: mapped.length
      });

      return best ?? null;
    },

    async createInstance(offer, context) {
      const api = await client();
      const hfToken = await options.getHfToken?.();
      const parameterCount = await options.getParameterCount(context.modelId);

      const instanceId = await api.createInstance({
        offerId: offer.offerId,
        image: options.containerImage ?? "vllm/vllm-openai:latest",
        diskGb: options.diskGb ?? estimateDiskGb(parameterCount),
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
