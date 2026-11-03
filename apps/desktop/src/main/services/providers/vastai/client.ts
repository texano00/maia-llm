import type { GpuFilters } from "@maia/contracts";
import { ProviderHttpClient } from "../http";
import type { ComputeOffer } from "../../sessions/orchestrator";

/**
 * Thin wrapper over the vast.ai REST API (v0).
 *
 * The API is documented at https://vast.ai/api/v0 ; responses are mapped
 * defensively because the provider occasionally changes payload nesting. Every
 * unexpected shape raises an actionable error instead of silently returning
 * "no GPU", which would look like a filters problem to the user.
 */
export interface VastAiOfferPayload {
  id: number;
  gpu_name?: string;
  gpu_ram?: number;
  num_gpus?: number;
  dph_total?: number;
  reliability2?: number;
  geolocation?: string;
  machine_id?: number;
  datacenter?: string | boolean;
  verified?: boolean;
}

export interface VastAiInstancePayload {
  id?: number;
  actual_status?: string;
  status_msg?: string;
  public_ipaddr?: string;
  ssh_host?: string;
  ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }>>;
  machine_id?: number;
}

export const VASTAI_BASE_URL = "https://console.vast.ai";

export interface VastAiSearchQuery {
  gpu_ram_gb: number;
  maxHourlyMicroUsd: number | null;
  filters: GpuFilters | undefined;
}

export function buildSearchQuery(input: VastAiSearchQuery): Record<string, unknown> {
  const q: Record<string, unknown> = {
    rentable: { eq: true },
    verified: { eq: true },
    num_gpus: { eq: 1 },
    gpu_ram: { gte: input.gpu_ram_gb * 1024 },
    order: [["dph_total", "asc"]]
  };

  if (input.maxHourlyMicroUsd !== null) {
    q.dph_total = { lte: input.maxHourlyMicroUsd / 1_000_000 };
  }
  if (input.filters?.minReliability !== null && input.filters?.minReliability !== undefined) {
    q.reliability2 = { gte: input.filters.minReliability };
  }
  if (input.filters && input.filters.countries.length > 0) {
    q.geolocation = { in: input.filters.countries.map((country) => country.toUpperCase()) };
  }
  if (input.filters && input.filters.datacenters.length > 0) {
    // Datacenter names are free-form on vast.ai; match them with `in` on the
    // machine ids the user saved as trusted names via the offers listing.
    q.datacenter = { in: input.filters.datacenters };
  }

  return q;
}

export function toComputeOffer(payload: VastAiOfferPayload): ComputeOffer | null {
  if (typeof payload.id !== "number" || typeof payload.dph_total !== "number") {
    return null;
  }

  return {
    offerId: payload.id,
    gpuName: payload.gpu_name ?? "unknown GPU",
    gpuRamGb: Math.round((payload.gpu_ram ?? 0) / 1024),
    hourlyRateMicroUsd: Math.round(payload.dph_total * 1_000_000),
    expectedWaitMinutes: 5,
    simulated: false
  };
}

export class VastAiClient {
  private readonly http: ProviderHttpClient;

  constructor(
    private readonly apiKey: string,
    options: { client?: ProviderHttpClient } = {}
  ) {
    this.http =
      options.client ??
      new ProviderHttpClient({ baseUrl: VASTAI_BASE_URL, timeoutMs: 20_000, maxRetries: 2 });
  }

  async testConnection(): Promise<boolean> {
    const response = await this.http.request("/api/v0/users/current/", {
      headers: this.authHeaders()
    });

    return response.ok;
  }

  async searchOffers(query: Record<string, unknown>): Promise<VastAiOfferPayload[]> {
    const response = await this.http.request("/api/v0/search/offers/", {
      method: "PUT",
      headers: { ...this.authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ q: query })
    });

    const payload = (await response.json()) as { offers?: VastAiOfferPayload[] };
    if (!Array.isArray(payload.offers)) {
      throw new Error("vast.ai returned no offer list; check the API key and try again.");
    }

    return payload.offers;
  }

  async createInstance(input: {
    offerId: number;
    image: string;
    diskGb: number;
    label: string;
    env: Record<string, string>;
    args: string[];
  }): Promise<number> {
    const response = await this.http.request(`/api/v0/asks/${input.offerId}/`, {
      method: "PUT",
      headers: { ...this.authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        image: input.image,
        disk: input.diskGb,
        label: input.label,
        runtype: "args",
        args: input.args,
        env: Object.entries(input.env)
          .map(([key, value]) => `-e ${key}=${value}`)
          .join(" ")
      })
    });

    const payload = (await response.json()) as { new_contract?: number; success?: boolean };
    if (typeof payload.new_contract !== "number") {
      throw new Error("vast.ai did not return an instance id; the offer may no longer be available.");
    }

    return payload.new_contract;
  }

  async getInstance(instanceId: number): Promise<VastAiInstancePayload> {
    const response = await this.http.request(`/api/v0/instances/${instanceId}/`, {
      headers: this.authHeaders()
    });

    const payload = (await response.json()) as
      | VastAiInstancePayload
      | { instances?: VastAiInstancePayload[] };

    if (payload !== null && typeof payload === "object" && "instances" in payload) {
      const [found] = payload.instances ?? [];
      if (!found) {
        throw new Error(`vast.ai instance ${instanceId} is not visible any more.`);
      }
      return found;
    }

    return payload as VastAiInstancePayload;
  }

  async destroyInstance(instanceId: number): Promise<void> {
    await this.http.request(`/api/v0/instances/${instanceId}/`, {
      method: "DELETE",
      headers: this.authHeaders()
    });
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }
}

/** Reads the mapped HTTP port from an instance payload. */
export function readMappedPort(instance: VastAiInstancePayload, containerPort = 8000): number | null {
  const entry = instance.ports?.[`${containerPort}/tcp`]?.[0];
  const port = entry?.HostPort ?? entry?.HostIp;
  const parsed = Number(port);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function readPublicHost(instance: VastAiInstancePayload): string | null {
  const host = instance.public_ipaddr ?? instance.ssh_host;
  if (!host) {
    return null;
  }

  return host.split(":")[0] ?? null;
}

/**
 * Conservative VRAM estimate for a runnable model: two bytes per parameter for a
 * bf16 checkpoint plus 30% for the KV cache and activations, rounded to a GPU
 * size that actually exists in the marketplace.
 */
export function estimateGpuRamGb(parameterCount: number | null): number {
  if (!parameterCount || parameterCount <= 0) {
    return 24;
  }

  const gib = (parameterCount * 2 * 1.3) / 1024 ** 3;
  const rounded = Math.ceil(gib / 8) * 8;

  return Math.min(160, Math.max(8, rounded));
}
