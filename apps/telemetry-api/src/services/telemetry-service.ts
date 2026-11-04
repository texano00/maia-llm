import type { DiagnosticsPayload } from "../diagnostics.js";
import type {
  TelemetryBatchRecord,
  TelemetryQuery,
  TelemetryRepository,
} from "../repositories/telemetry.js";

/** 30 days: long enough to compare releases, short enough to stay small. */
export const DEFAULT_RETENTION_DAYS = 30;

export interface TelemetryServiceOptions {
  repository: TelemetryRepository;
  /** How long ingested batches are kept; defaults to 30 days. */
  retentionMs?: number;
  now?: () => number;
}

/**
 * Telemetry ingestion rules: payloads are stored as batches (matched to one app
 * run) and old rows are pruned on write, so retention needs no cron job.
 */
export class TelemetryService {
  private readonly repository: TelemetryRepository;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(options: TelemetryServiceOptions) {
    this.repository = options.repository;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_DAYS * 24 * 60 * 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  async ingest(payload: DiagnosticsPayload): Promise<{ batchId: number; accepted: number }> {
    const receivedAt = new Date(this.now()).toISOString();

    const batchId = await this.repository.appendBatch({
      app: payload.app,
      version: payload.version,
      platform: payload.platform,
      receivedAt,
      events: payload.events.map((event) => ({
        occurredAt: new Date(event.time).toISOString(),
        level: event.level,
        message: event.message,
        context: event.context ?? null,
      })),
    });

    await this.prune();

    return { batchId, accepted: payload.events.length };
  }

  async recent(query: TelemetryQuery): Promise<TelemetryBatchRecord[]> {
    return this.repository.listBatches(query);
  }

  /** Drops batches older than the retention window; returns rows removed. */
  async prune(): Promise<number> {
    if (this.retentionMs <= 0) {
      return 0;
    }

    return this.repository.pruneBefore(new Date(this.now() - this.retentionMs).toISOString());
  }

  async countEvents(): Promise<number> {
    return this.repository.countEvents();
  }
}
