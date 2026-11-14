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
  ports?: Record<
    string,
    Array<{ HostIp?: string; HostPort?: string | number }> | { HostIp?: string; HostPort?: string | number }
  > | null;
  machine_id?: number;
  label?: string;
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


/**
 * Errors vast.ai reports for a container that can never start on that host, for
 * example a broken NVIDIA CDI setup (`failed to inject CDI devices`). Waiting for
 * these is pointless: the machine has to be avoided and another one booked.
 */
const INSTANCE_START_FAILURE_PATTERN =
  /failed to start containers|OCI runtime create failed|unresolvable CDI devices|failed to create task|failed to create shim|Error response from daemon/i;

export function isInstanceStartFailureMessage(message: string | null | undefined): boolean {
  return typeof message === "string" && INSTANCE_START_FAILURE_PATTERN.test(message);
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
    machineId: typeof payload.machine_id === "number" ? payload.machine_id : null,
    gpuName: payload.gpu_name ?? "unknown GPU",
    gpuRamGb: Math.round((payload.gpu_ram ?? 0) / 1024),
    hourlyRateMicroUsd: Math.round(payload.dph_total * 1_000_000),
    expectedWaitMinutes: 5,
    simulated: false
  };
}

/** Nothing about one instance changes faster than this. */
const INSTANCE_CACHE_MS = 3_000;
/** Reconciling and health checks share one account listing for this long. */
const LIST_CACHE_MS = 5_000;

export class VastAiClient {
  private readonly http: ProviderHttpClient;
  private readonly fetchImpl: typeof fetch;
  /** Polling reads the instance every few seconds; the answer is reused briefly. */
  private readonly instanceCache = new Map<number, { at: number; value: VastAiInstancePayload }>();
  private readonly instanceInFlight = new Map<number, Promise<VastAiInstancePayload>>();
  private listCache: { at: number; value: VastAiInstancePayload[] } | null = null;
  private listInFlight: Promise<VastAiInstancePayload[]> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly apiKey: string,
    options: {
      client?: ProviderHttpClient;
      fetchImpl?: typeof fetch;
      now?: () => number;
    } = {}
  ) {
    this.http =
      options.client ??
      // A boot polls for twenty minutes; the whole point is to stay under the
      // provider's rate limit rather than to hammer it and retry.
      new ProviderHttpClient({
        baseUrl: VASTAI_BASE_URL,
        timeoutMs: 20_000,
        maxRetries: 3,
        minIntervalMs: 250
      });
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.now = options.now ?? (() => Date.now());
  }

  async testConnection(): Promise<boolean> {
    const response = await this.http.request("/api/v0/users/current/", {
      headers: this.authHeaders()
    });

    return response.ok;
  }

  /**
   * Prepaid credit reported by the account endpoint, in micro-USD. Returns null
   * when the provider does not report a number, so the UI can show "unknown"
   * rather than a misleading zero.
   */
  async getBalanceMicroUsd(): Promise<number | null> {
    const response = await this.http.request("/api/v0/users/current/", {
      headers: this.authHeaders()
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as { credit?: unknown };
    return typeof payload.credit === "number" && Number.isFinite(payload.credit)
      ? Math.round(payload.credit * 1_000_000)
      : null;
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
    /**
     * `args` preserves the image entrypoint and feeds vLLM its flags; `ssh_direct`
     * replaces the entrypoint with Vast's and is the only runtype where `onstart`
     * runs as a shell script.
     */
    runtype?: "args" | "ssh_direct";
    /** vLLM arguments, used with the `args` runtype. */
    args?: string[];
    /** Shell script run before the server starts; requires the `ssh_direct` runtype. */
    onstart?: string;
    /** Container port published on the host, e.g. 8000 for the vLLM server. */
    port?: number;
  }): Promise<number> {
    const containerPort = input.port ?? 8000;

    // vast.ai takes Docker flags in `env` (documented: "Environment variables
    // **and port mappings** in Docker flag format") while `args` goes to the
    // image entrypoint. Sending `-p 8000:8000` as an entrypoint argument leaves
    // the port unpublished, so the model is served but unreachable.
    const dockerFlags = [
      ...Object.entries(input.env).map(([key, value]) => `-e ${key}=${value}`),
      `-p ${containerPort}:${containerPort}`
    ].join(" ");

    const response = await this.http.request(`/api/v0/asks/${input.offerId}/`, {
      method: "PUT",
      headers: { ...this.authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        image: input.image,
        disk: input.diskGb,
        label: input.label,
        runtype: input.runtype ?? "args",
        ...(input.args ? { args: input.args } : {}),
        env: dockerFlags,
        ...(input.onstart ? { onstart: input.onstart.slice(0, 4_048) } : {})
      })
    });

    const payload = (await response.json()) as { new_contract?: number; success?: boolean };
    if (typeof payload.new_contract !== "number") {
      throw new Error("vast.ai did not return an instance id; the offer may no longer be available.");
    }

    return payload.new_contract;
  }

  /**
   * Fetches the container log of an instance.
   *
   * vast.ai serves logs in two steps: `PUT /instances/request_logs/{id}/` queues
   * a request and answers with a signed URL that is readable for a short while.
   * Used when a boot fails, where the container output is the difference between
   * "the port never opened" and the real traceback — and now also for the live log
   * view, which is why it takes a tail size and a daemon flag.
   */
  async getInstanceLogs(
    instanceId: number,
    options: { tail?: number; daemon?: boolean } = {}
  ): Promise<string | null> {
    try {
      const response = await this.http.request(`/api/v0/instances/request_logs/${instanceId}/`, {
        method: "PUT",
        headers: { ...this.authHeaders(), "content-type": "application/json" },
        // `daemon` selects the host-side log instead of the container's stdout,
        // which is the only place a container that refused to start speaks.
        body: JSON.stringify({
          tail: String(options.tail ?? 200),
          ...(options.daemon ? { daemon: true } : {})
        })
      });

      const payload = (await response.json()) as { result_url?: unknown };
      const resultUrl = typeof payload.result_url === "string" ? payload.result_url : null;
      if (!resultUrl) {
        return null;
      }

      // The URL is served by storage, not the API: no Authorization header.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const logs = await this.fetchImpl(resultUrl, { signal: AbortSignal.timeout(10_000) });
        if (logs.ok) {
          const text = await logs.text();
          if (text.trim().length > 0) {
            return text;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      return null;
    } catch {
      // Logs are a diagnostic aid: never let them fail the failure path.
      return null;
    }
  }

  /**
   * One instance.
   *
   * A boot polls this every few seconds, and the old implementation fetched the
   * whole account and filtered it — one boot plus one open Models tab was enough
   * to earn `429 API requests too frequent`. A single-instance read is one request,
   * and the answer is reused for a couple of seconds because nothing on this
   * machine changes faster than that.
   */
  async getInstance(instanceId: number): Promise<VastAiInstancePayload> {
    const cached = this.instanceCache.get(instanceId);
    if (cached && this.now() - cached.at < INSTANCE_CACHE_MS) {
      return cached.value;
    }

    const inFlight = this.instanceInFlight.get(instanceId);
    if (inFlight) {
      return inFlight;
    }

    const request = (async () => {
      try {
        const response = await this.http.request(`/api/v0/instances/${instanceId}/`, {
          headers: this.authHeaders()
        });
        const payload = (await response.json()) as VastAiInstancePayload;
        const value = payload;
        this.instanceCache.set(instanceId, { at: this.now(), value });
        return value;
      } catch {
        // v0 is the documented single-instance shape; fall back to the list so a
        // rename on their side is a slowdown, never an outage.
        const list = await this.listInstances(true);
        const found = list.find((instance) => instance.id === instanceId);
        if (!found) {
          throw new Error(`vast.ai instance ${instanceId} is not visible any more.`);
        }

        this.instanceCache.set(instanceId, { at: this.now(), value: found });
        return found;
      } finally {
        this.instanceInFlight.delete(instanceId);
      }
    })();

    this.instanceInFlight.set(instanceId, request);
    return request;
  }

  /** Every instance on the account, used to find machines the app lost track of. */
  async listInstances(force = false): Promise<VastAiInstancePayload[]> {
    const fresh = this.listCache;
    if (!force && fresh && this.now() - fresh.at < LIST_CACHE_MS) {
      return fresh.value;
    }
    if (this.listInFlight) {
      return this.listInFlight;
    }

    const request = (async () => {
      const response = await this.http.request("/api/v1/instances/", {
        headers: this.authHeaders()
      });

    const payload = (await response.json()) as {
      instances?: VastAiInstancePayload[] | Record<string, VastAiInstancePayload> | null;
    };

      const instances = payload.instances;
      const value = Array.isArray(instances)
        ? instances
        : instances
          ? Object.values(instances)
          : [];
      this.listCache = { at: this.now(), value };
      return value;
    })().finally(() => {
      this.listInFlight = null;
    });

    this.listInFlight = request;
    return request;
  }

  /**
   * Releasing a GPU has to be idempotent: an instance can disappear on its own
   * (host failure, failed start), and a 404 then means "already gone", not an
   * error worth surfacing.
   */
  async destroyInstance(instanceId: number): Promise<void> {
    const attempt = async (version: "v0" | "v1"): Promise<void> => {
      await this.http.request(`/api/${version}/instances/${instanceId}/`, {
        method: "DELETE",
        headers: this.authHeaders()
      });
    };

    const gone = (error: unknown): boolean => {
      const status = (error as { status?: number }).status;
      return status === 404 || status === 410;
    };

    try {
      await attempt("v0");
      return;
    } catch (error) {
      if (!gone(error)) {
        throw error;
      }
    }

    try {
      await attempt("v1");
    } catch (error) {
      if (!gone(error)) {
        throw error;
      }
    }
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }
}

/** Reads the mapped HTTP port from an instance payload. */
export function readMappedPort(instance: VastAiInstancePayload, containerPort = 8000): number | null {
  const ports = instance.ports;
  if (!ports) {
    return null;
  }

  // vast.ai has used more than one key shape over time ("8000/tcp" and "8000").
  const entries = [
    ports[`${containerPort}/tcp`],
    ports[`${containerPort}`],
    ports[String(containerPort)]
  ];

  for (const entry of entries) {
    const first = Array.isArray(entry) ? entry[0] : entry;
    const port = Number(first?.HostPort);
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
  }

  return null;
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
