import type { GpuReputation, GpuReport, GpuStatus } from "../reputation-contract.js";
import type {
  GpuMachineRecord,
  GpuReputationRepository,
  GpuReportRecord,
  NewGpuReport,
} from "../repositories/gpu-reputation.js";

/** How long a failure keeps a machine out of circulation. */
export const DEFAULT_UNSTABLE_TTL_HOURS = 6;

export interface GpuReputationServiceOptions {
  repository: GpuReputationRepository;
  /** Freshness window for an `unstable` verdict; defaults to 6 hours. */
  unstableTtlMs?: number;
  now?: () => number;
}

/**
 * GPU reputation rules: counters, the manual override, and the freshness window
 * that makes an `unstable` verdict lapse.
 *
 * Storage is a repository, so these rules are independent of the database. The
 * status returned to clients is computed here rather than stored, which keeps a
 * host retryable once its owner has fixed it.
 */
export class GpuReputationService {
  private readonly repository: GpuReputationRepository;
  private readonly unstableTtlMs: number;
  private readonly now: () => number;

  constructor(options: GpuReputationServiceOptions) {
    this.repository = options.repository;
    this.unstableTtlMs = options.unstableTtlMs ?? DEFAULT_UNSTABLE_TTL_HOURS * 60 * 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  async list(limit: number, status?: GpuStatus): Promise<GpuReputation[]> {
    // Read one page, then filter: the freshness rule is applied in memory, so
    // filtering must happen after it, not in SQL.
    const machines = await this.repository.list(limit);
    const records = machines.map((machine) => this.withEffectiveStatus(machine));

    return status ? records.filter((record) => record.status === status) : records;
  }

  async get(machineId: number): Promise<GpuReputation | null> {
    const machine = await this.repository.find(machineId);
    return machine ? this.withEffectiveStatus(machine) : null;
  }

  async history(machineId: number, limit: number): Promise<GpuReportRecord[]> {
    return this.repository.listReports(machineId, limit);
  }

  /** Records the outcome of one provisioning attempt. */
  async report(machineId: number, report: GpuReport): Promise<GpuReputation> {
    const now = new Date(this.now()).toISOString();
    const existing = await this.repository.find(machineId);

    const record: GpuMachineRecord = existing
      ? { ...existing }
      : {
          machineId,
          gpuName: report.gpuName,
          status: "unknown",
          successes: 0,
          failures: 0,
          lastSuccessAt: null,
          lastFailureAt: null,
          lastError: null,
          updatedAt: now,
        };

    record.gpuName = report.gpuName;
    record.updatedAt = now;

    if (report.outcome === "success") {
      record.status = "good";
      record.successes += 1;
      record.failures = 0;
      record.lastSuccessAt = now;
      record.lastError = null;
    } else {
      record.status = "unstable";
      record.failures += 1;
      record.lastFailureAt = now;
      record.lastError = report.error ?? "The GPU could not start";
    }

    const history: NewGpuReport = {
      machineId,
      outcome: report.outcome,
      gpuName: report.gpuName,
      offerId: report.offerId ?? null,
      error: report.outcome === "failure" ? (report.error ?? null) : null,
      reportedAt: now,
    };

    await this.repository.save(record);
    await this.repository.appendReport(history);

    return this.withEffectiveStatus(record);
  }

  /** Manual override from the API (CRUD). */
  async upsert(
    machineId: number,
    input: { gpuName: string; status: GpuStatus; note?: string | undefined },
  ): Promise<GpuReputation> {
    const now = new Date(this.now()).toISOString();
    const existing = await this.repository.find(machineId);

    const record: GpuMachineRecord = {
      machineId,
      gpuName: input.gpuName,
      status: input.status,
      successes: existing?.successes ?? 0,
      failures: existing?.failures ?? 0,
      lastSuccessAt: input.status === "good" ? now : (existing?.lastSuccessAt ?? null),
      lastFailureAt: input.status === "unstable" ? now : (existing?.lastFailureAt ?? null),
      lastError: input.status === "unstable" ? (input.note ?? existing?.lastError ?? null) : null,
      updatedAt: now,
    };

    await this.repository.save(record);
    return this.withEffectiveStatus(record);
  }

  async remove(machineId: number): Promise<boolean> {
    return this.repository.remove(machineId);
  }

  async count(): Promise<number> {
    return this.repository.count();
  }

  /** A machine marked unstable is only avoidable while the verdict is fresh. */
  private withEffectiveStatus(record: GpuMachineRecord): GpuReputation {
    if (record.status !== "unstable" || !record.lastFailureAt) {
      return record;
    }

    const failedAt = Date.parse(record.lastFailureAt);
    if (!Number.isFinite(failedAt) || this.now() - failedAt < this.unstableTtlMs) {
      return record;
    }

    return { ...record, status: "unknown" };
  }
}
