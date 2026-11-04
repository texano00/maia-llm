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
  /** `false` means the machine cannot be booked right now, yet it stays listed. */
  rentable?: boolean;
  rented?: boolean;
  compute_cap?: number;
  verification?: string;
  inet_down?: number;
  inet_up?: number;
  disk_bw?: number;
  disk_space?: number;
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
  /** Minimum free disk the machine must offer, so the booking cannot be rejected. */
  minDiskGb?: number | undefined;
}

/**
 * vLLM requires compute capability 7.5 or newer (T4, RTX 20xx, A100, L40S,
 * H100…). Cheaper Volta cards (V100, 7.0) are still listed on vast.ai but the
 * image cannot run on them, so booking one only wastes the whole boot window.
 */
export const MIN_COMPUTE_CAPABILITY = 7.5;

/**
 * vast.ai keeps listing asks whose machine is not available (`rentable:false`),
 * and booking one answers `400 no_such_ask`. Only ~1 in 4 offers is rentable at
 * any moment, so this filter is what makes a booking attempt succeed.
 */
export function isRentableOffer(payload: Pick<VastAiOfferPayload, "rentable">): boolean {
  return payload.rentable !== false;
}

export interface StartupGates {
  minDownloadMbps?: number | null | undefined;
  minUploadMbps?: number | null | undefined;
  minDiskBandwidthMBps?: number | null | undefined;
}

export type OfferVerdict = "bookable" | "not-rentable" | "unsupported-capability" | "too-slow";

/**
 * Says why an offer cannot be used, so the picker can log and explain
 * rejections instead of silently returning "no GPU".
 */
export function classifyOffer(payload: VastAiOfferPayload, gates?: StartupGates): OfferVerdict {
  if (!isRentableOffer(payload)) {
    return "not-rentable";
  }

  const capability = payload.compute_cap;
  if (typeof capability === "number" && capability > 0) {
    // vast.ai reports hundredths (700 = 7.0, 860 = 8.6).
    const normalised = capability >= 100 ? capability / 100 : capability;
    if (normalised < MIN_COMPUTE_CAPABILITY) {
      return "unsupported-capability";
    }
  }

  // The API already filters on these, but it has been seen to ignore query keys
  // (`rentable`), so the gate is enforced here as well.
  const down = gates?.minDownloadMbps ?? 0;
  if (down > 0 && typeof payload.inet_down === "number" && payload.inet_down < down) {
    return "too-slow";
  }

  const up = gates?.minUploadMbps ?? 0;
  if (up > 0 && typeof payload.inet_up === "number" && payload.inet_up < up) {
    return "too-slow";
  }

  const disk = gates?.minDiskBandwidthMBps ?? 0;
  if (disk > 0 && typeof payload.disk_bw === "number" && payload.disk_bw < disk) {
    return "too-slow";
  }

  return "bookable";
}

/** Offers the app may actually try to book: rentable, capable and fast enough. */
export function isBookableOffer(payload: VastAiOfferPayload, gates?: StartupGates): boolean {
  return classifyOffer(payload, gates) === "bookable";
}

export function buildSearchQuery(input: VastAiSearchQuery): Record<string, unknown> {
  const q: Record<string, unknown> = {
    num_gpus: { eq: 1 },
    gpu_ram: { gte: input.gpu_ram_gb * 1024 }
  };

  if (input.maxHourlyMicroUsd !== null) {
    q.dph_total = { lte: input.maxHourlyMicroUsd / 1_000_000 };
  }
  if (input.minDiskGb !== undefined && input.minDiskGb > 0) {
    q.disk_space = { gte: input.minDiskGb };
  }
  // Sending `rentable: {eq: true}` is accepted but ignored by the bundle search,
  // so ghosts are filtered client-side via `classifyOffer`.
  q.compute_cap = { gte: MIN_COMPUTE_CAPABILITY };
  if (input.filters?.minDownloadMbps) {
    q.inet_down = { gte: input.filters.minDownloadMbps };
  }
  if (input.filters?.minUploadMbps) {
    q.inet_up = { gte: input.filters.minUploadMbps };
  }
  if (input.filters?.minDiskBandwidthMBps) {
    q.disk_bw = { gte: input.filters.minDiskBandwidthMBps };
  }
  if (input.filters?.minReliability !== null && input.filters?.minReliability !== undefined) {
    q.reliability2 = { gte: input.filters.minReliability };
  }
  // An empty `in` list is accepted by the API but matches nothing, which reads as
  // "no GPU available". Only send the filter when it actually has entries.
  const countries = (input.filters?.countries ?? []).map((country) => country.toUpperCase()).filter(Boolean);
  if (countries.length > 0) {
    q.geolocation = { in: countries };
  }
  const machineIds = (input.filters?.datacenters ?? [])
    .map((entry) => Number(entry))
    .filter((value) => Number.isFinite(value));
  if (machineIds.length > 0) {
    // Offers do not expose datacenter names, so trusted entries are matched
    // against the machine id of each offer.
    q.machine_id = { in: machineIds };
  }

  return q;
}

/**
 * Offers disappear between the estimate and the booking: renting the cheapest
 * match can fail with `400 invalid_args / no_such_ask`, which the app must treat
 * as "pick another machine" rather than as a fatal provider error.
 */
const OFFER_GONE_PATTERN =
  /no_such_ask|not available|no longer (?:be )?available|already (?:rented|taken|in use)|price (?:has )?changed|out of (?:stock|capacity)|insufficient/i;

export function isOfferUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (OFFER_GONE_PATTERN.test(message)) {
    return true;
  }

  const status = (error as { status?: number } | null)?.status;
  return status === 404 || status === 410;
}


/** `geolocation` arrives as "Italy, IT"; the ISO code is the last segment. */
export function readCountry(geolocation: string | undefined): string | null {
  if (!geolocation) {
    return null;
  }

  const code = geolocation.split(",").pop()?.trim().toUpperCase();
  return code && code.length >= 2 ? code : null;
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

  /**
   * Offers live at `GET /api/v0/bundles/?q=<json>`; the older
   * `PUT /api/v0/search/offers/` route now returns 404.
   */
  async searchOffers(query: Record<string, unknown>): Promise<VastAiOfferPayload[]> {
    const response = await this.http.request(
      `/api/v0/bundles/?q=${encodeURIComponent(JSON.stringify(query))}`,
      { headers: this.authHeaders() }
    );

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

  /**
   * `GET /api/v0/instances/` is deprecated in favour of `/api/v1/instances/`,
   * so listing and filtering by id is the shape that stays valid.
   */
  async getInstance(instanceId: number): Promise<VastAiInstancePayload> {
    const response = await this.http.request("/api/v1/instances/", {
      headers: this.authHeaders()
    });

    const payload = (await response.json()) as {
      instances?: VastAiInstancePayload[] | Record<string, VastAiInstancePayload> | null;
    };

    const instances = payload.instances;
    const list: VastAiInstancePayload[] = Array.isArray(instances)
      ? instances
      : instances
        ? Object.values(instances)
        : [];

    const found = list.find((instance) => instance.id === instanceId);
    if (!found) {
      throw new Error(`vast.ai instance ${instanceId} is not visible any more.`);
    }

    return found;
  }

  async destroyInstance(instanceId: number): Promise<void> {
    try {
      await this.http.request(`/api/v0/instances/${instanceId}/`, {
        method: "DELETE",
        headers: this.authHeaders()
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 404 && status !== 410) {
        throw error;
      }

      await this.http.request(`/api/v1/instances/${instanceId}/`, {
        method: "DELETE",
        headers: this.authHeaders()
      });
    }
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

/**
 * Container disk for a run: the bf16 weights plus wheel/cache headroom. vast.ai
 * rejects a booking whose disk exceeds the machine's free space, so the value has
 * to follow the model size instead of being a fixed 64 GB.
 */
export function estimateDiskGb(parameterCount: number | null): number {
  if (!parameterCount || parameterCount <= 0) {
    return 64;
  }

  const weightsGb = (parameterCount * 2) / 1024 ** 3;
  const required = Math.ceil(weightsGb * 1.2) + 30;

  return Math.min(400, Math.max(64, Math.ceil(required / 10) * 10));
}
