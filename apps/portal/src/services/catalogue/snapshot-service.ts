import { randomUUID } from "node:crypto";
import type { SqlDatabase } from "../../db/database.js";
import type { CatalogueClient } from "./huggingface.js";
import { mapCatalogModel, type CatalogModel } from "./model.js";

export interface SnapshotSummary {
  id: string;
  version: number;
  refreshedAt: string;
  modelCount: number;
  supportedCount: number;
}

export interface SnapshotRunResult {
  runId: string;
  outcome: "success" | "failed" | "already-running";
  models: number;
  failed: number;
  version?: number;
  error?: string;
}

export interface SnapshotServiceOptions {
  db: SqlDatabase;
  client: CatalogueClient;
  /** How many models one pass covers (top-downloaded first). */
  limit?: number;
  /** Repositories always included, whatever their download rank. */
  required?: readonly string[];
  /** How many snapshots to keep. */
  retention?: number;
  concurrency?: number;
  now?: () => number;
  logger?: { info(message: string): void; warn(message: string): void };
}

/**
 * Builds and publishes the catalogue snapshot.
 *
 * Two rules matter more than anything else here: a refresh publishes only when it
 * completed (a partial snapshot would make "supported" lie), and only one refresh
 * runs at a time (two overlapping passes would fight over the same rows).
 */
export class SnapshotService {
  private running: Promise<SnapshotRunResult> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: SnapshotServiceOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Single-flight: a second call while one runs is reported, not queued. */
  async refresh(trigger: "scheduled" | "manual"): Promise<SnapshotRunResult> {
    if (this.running) {
      return { runId: "", outcome: "already-running", models: 0, failed: 0 };
    }

    this.running = this.run(trigger).finally(() => {
      this.running = null;
    });

    return this.running;
  }

  async current(): Promise<{ snapshot: SnapshotSummary; models: CatalogModel[] } | null> {
    const rows = (await this.options.db.query(
      `SELECT id, version, created_at, model_count
         FROM snapshots ORDER BY version DESC LIMIT 1`
    )) as unknown as Array<{ id: string; version: number; created_at: string; model_count: number }>;
    const snapshot = rows[0];
    if (!snapshot) {
      return null;
    }

    const modelRows = (await this.options.db.query(
      `SELECT data_json FROM snapshot_models WHERE snapshot_id = ? ORDER BY model_id`,
      [snapshot.id]
    )) as unknown as Array<{ data_json: string }>;
    const models = modelRows.map((row) => JSON.parse(row.data_json) as CatalogModel);

    return {
      snapshot: {
        id: snapshot.id,
        version: Number(snapshot.version),
        refreshedAt: snapshot.created_at,
        modelCount: Number(snapshot.model_count),
        supportedCount: models.filter((model) => model.supported).length
      },
      models
    };
  }

  async listRuns(limit = 20) {
    const rows = (await this.options.db.query(
      `SELECT id, trigger, started_at, finished_at, outcome, models, failed, error
         FROM refresh_runs ORDER BY started_at DESC LIMIT ?`,
      [limit]
    )) as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      trigger: String(row.trigger),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
      outcome: String(row.outcome),
      models: Number(row.models),
      failed: Number(row.failed),
      error: row.error === null ? null : String(row.error)
    }));
  }

  private async run(trigger: "scheduled" | "manual"): Promise<SnapshotRunResult> {
    const runId = randomUUID();
    const startedAt = new Date(this.now()).toISOString();
    const limit = this.options.limit ?? 300;

    await this.options.db.execute(
      `INSERT INTO refresh_runs (id, trigger, started_at, finished_at, outcome, models, failed, error)
       VALUES (?, ?, ?, NULL, 'running', 0, 0, NULL)`,
      [runId, trigger, startedAt]
    );

    try {
      // Copied: the extra repository below must not mutate the client's array.
      const payloads = [...(await this.options.client.listModels(limit))];
      const listed = new Set(
        payloads.map((payload) => payload.id).filter((id): id is string => Boolean(id))
      );
      // A required repository can be missing from the ranked listing entirely:
      // it is newer than the top 300, or its pipeline tag differs. Reading it by
      // id is what makes a catalogue that people search for complete.
      const required = (this.options.required ?? []).filter((id) => !listed.has(id));
      const extra = await mapLimit(required, this.options.concurrency ?? 6, async (id) => {
        try {
          return await this.options.client.readModel(id);
        } catch {
          return null;
        }
      });
      for (const payload of extra) {
        if (payload?.id) {
          payloads.push(payload);
        }
      }

      const refreshedAt = new Date(this.now()).toISOString();

      let failed = 0;
      const mapped = await mapLimit(payloads, this.options.concurrency ?? 6, async (payload) => {
        const id = payload.id;
        if (!id) {
          failed += 1;
          return null;
        }

        try {
          const files = await this.options.client.getFiles(id);
          const chatTemplate = await this.options.client.hasChatTemplate(id);
          return mapCatalogModel({
            payload: { ...payload, siblings: files },
            refreshedAt,
            chatTemplate
          });
        } catch {
          failed += 1;
          return null;
        }
      });

      const models = mapped.filter((model): model is CatalogModel => model !== null);

      if (models.length === 0) {
        throw new Error(
          `the provider returned ${payloads.length} models but none could be mapped; keeping the previous snapshot`
        );
      }

      const version = await this.nextVersion();
      const snapshotId = randomUUID();

      await this.publish(snapshotId, version, refreshedAt, models);
      await this.finishRun(runId, "success", models.length, failed, null);
      await this.prune(version);

      this.options.logger?.info(
        `Catalogue snapshot v${version} published: ${models.length} models (${failed} failed)`
      );

      return { runId, outcome: "success", models: models.length, failed, version };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finishRun(runId, "failed", 0, 0, message.slice(0, 500));
      this.options.logger?.warn(`Catalogue refresh failed: ${message}`);

      return { runId, outcome: "failed", models: 0, failed: 0, error: message };
    }
  }

  private async nextVersion(): Promise<number> {
    const rows = (await this.options.db.query(
      `SELECT COALESCE(MAX(version), 0) AS version FROM snapshots`
    )) as unknown as Array<{ version: number }>;

    return Number(rows[0]?.version ?? 0) + 1;
  }

  private async publish(
    snapshotId: string,
    version: number,
    refreshedAt: string,
    models: CatalogModel[]
  ): Promise<void> {
    await this.options.db.execute(
      `INSERT INTO snapshots (id, version, created_at, model_count)
       VALUES (?, ?, ?, ?)`,
      [snapshotId, version, refreshedAt, models.length]
    );

    for (const model of models) {
      await this.options.db.execute(
        `INSERT INTO snapshot_models (snapshot_id, model_id, data_json) VALUES (?, ?, ?)`,
        [snapshotId, model.id, JSON.stringify(model)]
      );
    }
  }

  private async finishRun(
    runId: string,
    outcome: "success" | "failed",
    models: number,
    failed: number,
    error: string | null
  ): Promise<void> {
    await this.options.db.execute(
      `UPDATE refresh_runs SET finished_at = ?, outcome = ?, models = ?, failed = ?, error = ?
        WHERE id = ?`,
      [new Date(this.now()).toISOString(), outcome, models, failed, error, runId]
    );
  }

  private async prune(currentVersion: number): Promise<void> {
    const retention = this.options.retention ?? 30;
    const cutoff = currentVersion - retention;
    if (cutoff <= 0) {
      return;
    }

    const stale = (await this.options.db.query(
      `SELECT id FROM snapshots WHERE version <= ?`,
      [cutoff]
    )) as unknown as Array<{ id: string }>;

    for (const row of stale) {
      await this.options.db.execute(`DELETE FROM snapshot_models WHERE snapshot_id = ?`, [row.id]);
      await this.options.db.execute(`DELETE FROM snapshots WHERE id = ?`, [row.id]);
    }
  }
}

/** Runs `worker` over `items` with a bounded number in flight. */
async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index] as T);
    }
  });

  await Promise.all(runners);
  return results;
}
