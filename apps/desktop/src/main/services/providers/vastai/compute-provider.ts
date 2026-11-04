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

export interface InstanceEndpoint {
  host: string;
  port: number;
}

export interface ProvisioningProgress {
  /** vast.ai instance status: scheduling, loading, running… */
  status: string;
  /** Provider message for that status, when it sends one. */
  message: string | null;
  elapsedMs: number;
}

/**
 * Real vast.ai provisioning. Instances are created from the chosen offer with a
 * vLLM container, labelled `maia:<install>:<session>`, and destroyed on teardown.
 */
export function createVastComputeProvider(options: VastComputeProviderOptions): ComputeProvider & {
  resolveEndpoint(instanceId: number): InstanceEndpoint | null;
  listLabelledInstances(prefix: string): Promise<Array<{ instanceId: number; label: string }>>;
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
        env: {
          // Parallel ranged downloads: the weights are 15 GB for a 7B model, and
          // Hugging Face limits a single stream, so this is the difference
          // between minutes and tens of minutes on a fast host.
          HF_HUB_ENABLE_HF_TRANSFER: "1",
          ...(hfToken ? { HUGGING_FACE_HUB_TOKEN: hfToken } : {})
        },
        // Only vLLM arguments: the port mapping belongs to the Docker flags in
        // `env`, otherwise nothing is published and the model is unreachable.
        args: [
          "--model",
          context.modelId,
          "--port",
          "8000",
          // Skip CUDA graph capture and per-request logging: both cost startup
          // time, and the graphs matter less than answering sooner.
          "--enforce-eager",
          "--disable-log-requests"
        ],
        port: 8000
      });

      options.logger?.info("vast.ai instance requested", { instanceId, offerId: offer.offerId });
      return { instanceId };
    },

    async waitUntilReady(instanceId, timeoutMs, onProgress) {
      const api = await client();
      const deadline = Date.now() + (options.readyTimeoutMs ?? timeoutMs);
      const pollInterval = options.pollIntervalMs ?? 5_000;
      const startedAt = Date.now();
      let lastStatus = "";
      let unknownSince: number | null = null;

      for (;;) {
        const instance = await api.getInstance(instanceId);
        const status = instance.actual_status ?? "unknown";

        if (status !== lastStatus) {
          lastStatus = status;
          onProgress?.({
            status,
            message: instance.status_msg ?? null,
            elapsedMs: Date.now() - startedAt
          });
        }

        // A freshly created instance reports `unknown` until the host reports
        // back, so only a persistent unknown/offline is fatal.
        if (status === "unknown" || status === "offline") {
          unknownSince ??= Date.now();
          if (Date.now() - unknownSince > 120_000) {
            throw new Error(`The GPU instance never became visible (${status}).`);
          }
        } else {
          unknownSince = null;
        }

        if (["exited", "error", "destroyed"].includes(status)) {
          throw new Error(`The GPU instance stopped while starting up (${status}).`);
        }

        if (status === "running") {
          const host = readPublicHost(instance);
          const port = readMappedPort(instance);
          if (host && port) {
            endpoints.set(instanceId, { host, port });
            onProgress?.({ status: "starting", message: "waiting for the model server", elapsedMs: Date.now() - startedAt });
            const served = await waitForServing(`http://${host}:${port}`, deadline, options.fetchImpl);
            if (served === null) {
              throw new Error(
                "The model server did not become ready in time. The GPU was released — a cold start can take several minutes when the host is slow."
              );
            }

            options.logger?.info("Model server is serving", { instanceId, models: served });
            return;
          }
        }

        // vast.ai documents that `exited`, `unknown` and `offline` never recover.
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for the GPU instance to start (${Math.round((Date.now() - startedAt) / 60_000)} min). The GPU was released.`
          );
        }

        await sleep(pollInterval);
      }
    },

    async destroyInstance(instanceId) {
      endpoints.delete(instanceId);
      const api = await client();
      await api.destroyInstance(instanceId);
    },

    async listLabelledInstances(prefix: string): Promise<Array<{ instanceId: number; label: string }>> {
      const api = await client();
      const instances = await api.listInstances();

      return instances
        .filter((instance) => typeof instance.id === "number")
        .map((instance) => ({ instanceId: instance.id as number, label: instance.label ?? "" }))
        .filter((instance) => instance.label.startsWith(prefix));
    }
  };
}

/**
 * Waits until the OpenAI surface answers and lists at least one model, which is
 * the only proof that the GPU is actually serving rather than merely running.
 * Returns the served model ids, or null on timeout.
 */
async function waitForServing(
  baseUrl: string,
  deadline: number,
  fetchImpl: typeof fetch = fetch
): Promise<string[] | null> {
  for (;;) {
    try {
      const health = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      if (health.ok) {
        const models = await fetchImpl(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(5_000) });
        if (models.ok) {
          const payload = (await models.json()) as { data?: Array<{ id?: string }> };
          const ids = (payload.data ?? []).map((entry) => entry.id ?? "").filter(Boolean);
          if (ids.length > 0) {
            return ids;
          }
        }
      }
    } catch {
      // Model servers reject connections until vLLM finished loading weights.
    }

    if (Date.now() > deadline) {
      return null;
    }

    await sleep(5_000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
