import type { SqlDatabase } from "../db/database.js";
import type { FailureReport } from "../failure-contract.js";

export interface FailureRecord extends FailureReport {
  id: number;
  receivedAt: string;
}

export interface FailureRepository {
  append(report: FailureReport, receivedAt: string): Promise<number>;
  /** Newest first. */
  list(limit: number): Promise<FailureRecord[]>;
}

interface FailureRow {
  id: number;
  received_at: string;
  occurred_at: string | null;
  app_version: string;
  platform: string;
  stage: string;
  model_id: string | null;
  gpu_name: string | null;
  machine_id: number | null;
  instance_id: number | null;
  attempt: number | null;
  attempts_total: number | null;
  error_class: string;
  error_message: string;
  root_cause: string | null;
  memory_note: string | null;
  model_failure: string | null;
  context_scale: number | null;
  log_tail: string | null;
}

function toRecord(row: FailureRow): FailureRecord {
  return {
    id: row.id,
    receivedAt: row.received_at,
    ...(row.occurred_at ? { occurredAt: row.occurred_at } : {}),
    appVersion: row.app_version,
    platform: row.platform,
    stage: row.stage as FailureReport["stage"],
    modelId: row.model_id,
    gpuName: row.gpu_name,
    machineId: row.machine_id,
    instanceId: row.instance_id,
    attempt: row.attempt,
    attemptsTotal: row.attempts_total,
    errorClass: row.error_class,
    errorMessage: row.error_message,
    rootCause: row.root_cause,
    memoryNote: row.memory_note,
    modelFailure: row.model_failure,
    contextScale: row.context_scale,
    logTail: row.log_tail
  };
}

export function createFailureRepository(db: SqlDatabase): FailureRepository {
  return {
    async append(report, receivedAt) {
      const result = await db.execute(
        `INSERT INTO failure_reports
          (received_at, occurred_at, app_version, platform, stage, model_id, gpu_name,
           machine_id, instance_id, attempt, attempts_total, error_class, error_message,
           root_cause, memory_note, model_failure, context_scale, log_tail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          receivedAt,
          report.occurredAt ?? null,
          report.appVersion,
          report.platform,
          report.stage,
          report.modelId ?? null,
          report.gpuName ?? null,
          report.machineId ?? null,
          report.instanceId ?? null,
          report.attempt ?? null,
          report.attemptsTotal ?? null,
          report.errorClass,
          report.errorMessage,
          report.rootCause ?? null,
          report.memoryNote ?? null,
          report.modelFailure ?? null,
          report.contextScale ?? null,
          report.logTail ?? null
        ]
      );

      return Number(result.lastInsertId ?? 0);
    },

    async list(limit) {
      const rows = (await db.query(
        `SELECT * FROM failure_reports ORDER BY received_at DESC, id DESC LIMIT ?`,
        [limit]
      )) as unknown as FailureRow[];

      return rows.map(toRecord);
    }
  };
}
