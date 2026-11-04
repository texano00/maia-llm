import type { SqlDatabase } from "../db/database.js";
import type { GpuOutcome, GpuStatus } from "../reputation-contract.js";

/** Current verdict for a physical host, as stored in `gpu_machines`. */
export interface GpuMachineRecord {
  machineId: number;
  gpuName: string;
  status: GpuStatus;
  successes: number;
  failures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

/** One provisioning attempt, as stored in `gpu_reports` (append-only). */
export interface GpuReportRecord {
  id: number;
  machineId: number;
  outcome: GpuOutcome;
  gpuName: string;
  offerId: number | null;
  error: string | null;
  reportedAt: string;
}

export type NewGpuReport = Omit<GpuReportRecord, "id">;

/**
 * Persistence for GPU verdicts. Deliberately free of rules: freshness, counters
 * and overrides live in {@link GpuReputationService}, so the storage layer can
 * be replaced without re-testing the behaviour.
 */
export interface GpuReputationRepository {
  /** Most recently updated machines first. */
  list(limit: number): Promise<GpuMachineRecord[]>;
  find(machineId: number): Promise<GpuMachineRecord | null>;
  /** Inserts or replaces the row for `record.machineId`. */
  save(record: GpuMachineRecord): Promise<void>;
  /** Removes the machine and its history; `true` when a row existed. */
  remove(machineId: number): Promise<boolean>;
  appendReport(report: NewGpuReport): Promise<void>;
  /** Newest first. */
  listReports(machineId: number, limit: number): Promise<GpuReportRecord[]>;
  count(): Promise<number>;
}

const COLUMNS = `machine_id, gpu_name, status, successes, failures,
  last_success_at, last_failure_at, last_error, updated_at`;

const REPORT_COLUMNS = `id, machine_id, outcome, gpu_name, offer_id, error, reported_at`;

function toMachine(row: Record<string, unknown>): GpuMachineRecord {
  return {
    machineId: Number(row.machine_id),
    gpuName: String(row.gpu_name),
    status: String(row.status) as GpuStatus,
    successes: Number(row.successes),
    failures: Number(row.failures),
    lastSuccessAt: row.last_success_at === null ? null : String(row.last_success_at),
    lastFailureAt: row.last_failure_at === null ? null : String(row.last_failure_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    updatedAt: String(row.updated_at),
  };
}

function toReport(row: Record<string, unknown>): GpuReportRecord {
  return {
    id: Number(row.id),
    machineId: Number(row.machine_id),
    outcome: String(row.outcome) as GpuOutcome,
    gpuName: String(row.gpu_name),
    offerId: row.offer_id === null ? null : Number(row.offer_id),
    error: row.error === null ? null : String(row.error),
    reportedAt: String(row.reported_at),
  };
}

/**
 * SQL implementation shared by every dialect.
 *
 * An upsert is a read-modify-write instead of `ON CONFLICT` / `ON DUPLICATE
 * KEY`, which keeps the statement identical on SQLite, PostgreSQL and MySQL.
 * The caller wraps it in a transaction where it matters.
 */
export function createGpuReputationRepository(db: SqlDatabase): GpuReputationRepository {
  return {
    async list(limit) {
      const rows = await db.query(
        `SELECT ${COLUMNS} FROM gpu_machines
         ORDER BY updated_at DESC, machine_id ASC
         LIMIT ?`,
        [limit],
      );
      return rows.map(toMachine);
    },

    async find(machineId) {
      const rows = await db.query(`SELECT ${COLUMNS} FROM gpu_machines WHERE machine_id = ?`, [
        machineId,
      ]);
      const row = rows[0];
      return row ? toMachine(row) : null;
    },

    async save(record) {
      const values = [
        record.gpuName,
        record.status,
        record.successes,
        record.failures,
        record.lastSuccessAt,
        record.lastFailureAt,
        record.lastError,
        record.updatedAt,
        record.machineId,
      ];

      const updated = await db.execute(
        `UPDATE gpu_machines SET gpu_name = ?, status = ?, successes = ?, failures = ?,
           last_success_at = ?, last_failure_at = ?, last_error = ?, updated_at = ?
         WHERE machine_id = ?`,
        values,
      );

      if (updated.changes > 0) {
        return;
      }

      await db.execute(
        `INSERT INTO gpu_machines (gpu_name, status, successes, failures,
           last_success_at, last_failure_at, last_error, updated_at, machine_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        values,
      );
    },

    async remove(machineId) {
      return db.transaction(async (tx) => {
        await tx.execute("DELETE FROM gpu_reports WHERE machine_id = ?", [machineId]);
        const result = await tx.execute("DELETE FROM gpu_machines WHERE machine_id = ?", [
          machineId,
        ]);
        return result.changes > 0;
      });
    },

    async appendReport(report) {
      await db.execute(
        `INSERT INTO gpu_reports (machine_id, outcome, gpu_name, offer_id, error, reported_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          report.machineId,
          report.outcome,
          report.gpuName,
          report.offerId,
          report.error,
          report.reportedAt,
        ],
      );
    },

    async listReports(machineId, limit) {
      const rows = await db.query(
        `SELECT ${REPORT_COLUMNS} FROM gpu_reports
         WHERE machine_id = ?
         ORDER BY reported_at DESC, id DESC
         LIMIT ?`,
        [machineId, limit],
      );
      return rows.map(toReport);
    },

    async count() {
      const rows = await db.query<{ total: number }>("SELECT COUNT(*) AS total FROM gpu_machines");
      return Number(rows[0]?.total ?? 0);
    },
  };
}
