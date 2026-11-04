import type { SqlDatabase } from "../db/database.js";

export interface TelemetryEventInput {
  /** When the client observed the event (ISO-8601 UTC). */
  occurredAt: string;
  level: string;
  message: string;
  context: Record<string, unknown> | null;
}

export interface TelemetryEventRecord extends TelemetryEventInput {
  id: number;
  batchId: number;
}

export interface TelemetryBatchInput {
  app: string;
  version: string;
  platform: string;
  receivedAt: string;
  events: readonly TelemetryEventInput[];
}

export interface TelemetryBatchRecord {
  id: number;
  app: string;
  version: string;
  platform: string;
  receivedAt: string;
  events: TelemetryEventRecord[];
}

export interface TelemetryQuery {
  /** Maximum number of batches returned, newest first. */
  limit: number;
  /** Only batches received at or after this instant. */
  since?: string | undefined;
  /** Only events with this level; batches left empty are dropped. */
  level?: string | undefined;
}

export interface TelemetryRepository {
  /** Stores a batch and its events atomically; returns the batch id. */
  appendBatch(batch: TelemetryBatchInput): Promise<number>;
  /** Newest batch first, events in arrival order. */
  listBatches(query: TelemetryQuery): Promise<TelemetryBatchRecord[]>;
  /** Deletes batches (and their events) received before `before`. */
  pruneBefore(before: string): Promise<number>;
  countEvents(): Promise<number>;
}

function parseContext(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function createTelemetryRepository(db: SqlDatabase): TelemetryRepository {
  return {
    async appendBatch(batch) {
      const batchId = await db.transaction(async (tx) => {
        const inserted = await tx.execute(
          `INSERT INTO telemetry_batches (app, version, platform, event_count, received_at)
           VALUES (?, ?, ?, ?, ?)`,
          [batch.app, batch.version, batch.platform, batch.events.length, batch.receivedAt],
        );

        const id = inserted.lastInsertId;
        if (id === null) {
          throw new Error("The database did not report an id for the telemetry batch");
        }

        for (const event of batch.events) {
          await tx.execute(
            `INSERT INTO telemetry_events (batch_id, occurred_at, level, message, context_json)
             VALUES (?, ?, ?, ?, ?)`,
            [
              id,
              event.occurredAt,
              event.level,
              event.message,
              event.context ? JSON.stringify(event.context) : null,
            ],
          );
        }

        return id;
      });

      return batchId;
    },

    async listBatches(query) {
      const conditions: string[] = [];
      const params: Array<string | number> = [];

      if (query.since) {
        conditions.push("received_at >= ?");
        params.push(query.since);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const batches = await db.query<{
        id: number;
        app: string;
        version: string;
        platform: string;
        received_at: string;
      }>(
        `SELECT id, app, version, platform, received_at FROM telemetry_batches
         ${where}
         ORDER BY id DESC
         LIMIT ?`,
        [...params, query.limit],
      );

      if (batches.length === 0) {
        return [];
      }

      const ids = batches.map((batch) => Number(batch.id));
      const placeholders = ids.map(() => "?").join(", ");
      const eventFilter = query.level ? "AND level = ?" : "";
      const eventParams: Array<string | number> = [...ids];
      if (query.level) {
        eventParams.push(query.level);
      }

      const events = await db.query<{
        id: number;
        batch_id: number;
        occurred_at: string;
        level: string;
        message: string;
        context_json: string | null;
      }>(
        `SELECT id, batch_id, occurred_at, level, message, context_json FROM telemetry_events
         WHERE batch_id IN (${placeholders}) ${eventFilter}
         ORDER BY id ASC`,
        eventParams,
      );

      const byBatch = new Map<number, TelemetryEventRecord[]>();
      for (const event of events) {
        const batchId = Number(event.batch_id);
        const list = byBatch.get(batchId) ?? [];
        list.push({
          id: Number(event.id),
          batchId,
          occurredAt: String(event.occurred_at),
          level: String(event.level),
          message: String(event.message),
          context: parseContext(event.context_json),
        });
        byBatch.set(batchId, list);
      }

      return batches.flatMap((batch) => {
        const batchEvents = byBatch.get(Number(batch.id)) ?? [];
        if (query.level && batchEvents.length === 0) {
          return [];
        }

        return [
          {
            id: Number(batch.id),
            app: String(batch.app),
            version: String(batch.version),
            platform: String(batch.platform),
            receivedAt: String(batch.received_at),
            events: batchEvents,
          },
        ];
      });
    },

    async pruneBefore(before) {
      return db.transaction(async (tx) => {
        const expired = await tx.query<{ id: number }>(
          "SELECT id FROM telemetry_batches WHERE received_at < ?",
          [before],
        );

        if (expired.length === 0) {
          return 0;
        }

        const ids = expired.map((row) => Number(row.id));
        const placeholders = ids.map(() => "?").join(", ");
        await tx.execute(`DELETE FROM telemetry_events WHERE batch_id IN (${placeholders})`, ids);
        const deleted = await tx.execute(
          `DELETE FROM telemetry_batches WHERE id IN (${placeholders})`,
          ids,
        );

        return deleted.changes;
      });
    },

    async countEvents() {
      const rows = await db.query<{ total: number }>(
        "SELECT COUNT(*) AS total FROM telemetry_events",
      );
      return Number(rows[0]?.total ?? 0);
    },
  };
}
