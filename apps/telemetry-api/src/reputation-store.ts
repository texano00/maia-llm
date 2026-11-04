import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  gpuReputationSchema,
  type GpuReputation,
  type GpuReport,
  type GpuStatus
} from "./reputation-contract.js";

const fileSchema = z.object({
  version: z.literal(1),
  gpus: z.array(gpuReputationSchema)
});

/** How long a failure keeps a machine out of circulation. */
const DEFAULT_UNSTABLE_TTL_HOURS = 6;

export interface GpuReputationStoreOptions {
  filePath: string;
  unstableTtlMs?: number;
  now?: () => number;
}

/**
 * Shared GPU reputation: which machines actually start, and which ones burn a
 * boot window and fail. Backed by a small JSON file so every Maia workspace
 * reads the same verdicts; a write is atomic (temp file + rename).
 */
export class GpuReputationStore {
  private readonly gpus = new Map<number, GpuReputation>();
  private readonly unstableTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: GpuReputationStoreOptions) {
    this.unstableTtlMs =
      options.unstableTtlMs ??
      Number(process.env.MAIA_UNSTABLE_TTL_HOURS ?? DEFAULT_UNSTABLE_TTL_HOURS) * 60 * 60_000;
    this.now = options.now ?? (() => Date.now());
    this.load();
  }

  list(): GpuReputation[] {
    return [...this.gpus.values()]
      .map((record) => this.withEffectiveStatus(record))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(machineId: number): GpuReputation | null {
    const record = this.gpus.get(machineId);
    return record ? this.withEffectiveStatus(record) : null;
  }

  /** Records the outcome of one provisioning attempt. */
  report(machineId: number, report: GpuReport): GpuReputation {
    const now = new Date(this.now()).toISOString();
    const existing = this.gpus.get(machineId);

    const record: GpuReputation = existing
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
          updatedAt: now
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

    this.gpus.set(machineId, record);
    this.persist();
    return this.withEffectiveStatus(record);
  }

  /** Manual override from the API (CRUD). */
  upsert(
    machineId: number,
    input: { gpuName: string; status: GpuStatus; note?: string | undefined }
  ): GpuReputation {
    const now = new Date(this.now()).toISOString();
    const existing = this.gpus.get(machineId);

    const record: GpuReputation = {
      machineId,
      gpuName: input.gpuName,
      status: input.status,
      successes: existing?.successes ?? 0,
      failures: existing?.failures ?? 0,
      lastSuccessAt: input.status === "good" ? now : (existing?.lastSuccessAt ?? null),
      lastFailureAt: input.status === "unstable" ? now : (existing?.lastFailureAt ?? null),
      lastError: input.status === "unstable" ? (input.note ?? existing?.lastError ?? null) : null,
      updatedAt: now
    };

    this.gpus.set(machineId, record);
    this.persist();
    return record;
  }

  remove(machineId: number): boolean {
    const existed = this.gpus.delete(machineId);
    if (existed) {
      this.persist();
    }
    return existed;
  }

  /** A machine marked unstable is only avoidable while the verdict is fresh. */
  private withEffectiveStatus(record: GpuReputation): GpuReputation {
    if (record.status !== "unstable" || !record.lastFailureAt) {
      return record;
    }

    const failedAt = Date.parse(record.lastFailureAt);
    if (!Number.isFinite(failedAt) || this.now() - failedAt < this.unstableTtlMs) {
      return record;
    }

    return { ...record, status: "unknown" };
  }

  private load(): void {
    try {
      const raw = readFileSync(this.options.filePath, "utf8");
      const parsed = fileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        return;
      }

      for (const record of parsed.data.gpus) {
        this.gpus.set(record.machineId, record);
      }
    } catch {
      // No file yet, or unreadable: start empty rather than failing requests.
    }
  }

  private persist(): void {
    const payload = { version: 1 as const, gpus: [...this.gpus.values()] };

    try {
      mkdirSync(dirname(this.options.filePath), { recursive: true });
      const temp = `${this.options.filePath}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(payload, null, 2), "utf8");
      renameSync(temp, this.options.filePath);
    } catch {
      // Persistence is best effort; the in-memory state stays authoritative.
    }
  }
}
