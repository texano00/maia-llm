import {
  DEFAULT_REPUTATION_URL,
  gpuListSchema,
  type GpuOutcome,
  type GpuReputation
} from "@maia/contracts";

export interface GpuReputationClientOptions {
  /** Host or full base URL; the repo's service lives beside the telemetry API. */
  getBaseUrl?: () => string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** How long a snapshot is reused before asking the service again. */
  cacheTtlMs?: number;
  logger?: { warn(message: string, context?: Record<string, unknown>): void } | undefined;
}

export interface GpuOutcomeReport {
  machineId: number | null;
  gpuName: string;
  outcome: GpuOutcome;
  offerId?: number;
  error?: string;
}

/**
 * Client for the shared GPU reputation API. Everything here is best effort: the
 * app must be able to rent a GPU when the service is unreachable, so a failed
 * read means "no history" and a failed write is logged and dropped.
 */
export class GpuReputationClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private cache: Map<number, GpuReputation> = new Map();
  private cachedAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly options: GpuReputationClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 4_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
  }

  baseUrl(): string {
    const configured = this.options.getBaseUrl?.()?.trim();
    return (configured && configured.length > 0 ? configured : DEFAULT_REPUTATION_URL).replace(
      /\/+$/,
      ""
    );
  }

  /** Cached view of the shared verdicts, keyed by `machine_id`. */
  async snapshot(): Promise<Map<number, GpuReputation>> {
    if (Date.now() - this.cachedAt < this.cacheTtlMs) {
      return this.cache;
    }

    if (!this.inFlight) {
      this.inFlight = this.refresh();
    }

    await this.inFlight;
    return this.cache;
  }

  async refresh(): Promise<void> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl()}/v1/gpus?limit=1000`, {
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (!response.ok) {
        throw new Error(`GPU reputation returned HTTP ${response.status}`);
      }

      const payload = gpuListSchema.parse(await response.json());
      this.cache = new Map(payload.gpus.map((record) => [record.machineId, record]));
      this.cachedAt = Date.now();
    } catch (error) {
      // Fail open: unknown machines stay eligible, the booking path is unaffected.
      this.options.logger?.warn("GPU reputation unavailable", {
        reason: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.inFlight = null;
    }
  }

  /** Reports the outcome of one attempt. Never throws. */
  async report(report: GpuOutcomeReport): Promise<void> {
    if (report.machineId === null) {
      return;
    }

    try {
      await this.fetchImpl(`${this.baseUrl()}/v1/gpus/${report.machineId}/reports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outcome: report.outcome,
          gpuName: report.gpuName,
          ...(report.offerId === undefined ? {} : { offerId: report.offerId }),
          ...(report.error === undefined ? {} : { error: report.error.slice(0, 600) })
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      // The verdict changed, so the next ranking must see it immediately.
      this.cachedAt = 0;
    } catch (error) {
      this.options.logger?.warn("Could not report GPU outcome", {
        machineId: report.machineId,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
