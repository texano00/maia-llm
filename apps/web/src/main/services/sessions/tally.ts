import type { ProvisioningSummary, ReleaseReason } from "@maia/contracts";
import type { DatabaseConnection } from "../../storage/db";

/**
 * Releases by day and reason, for the operator (feature 011, FR-036).
 *
 * Counts only. The query never selects an account id, a machine id, a model id,
 * a host or a port, so the projection cannot leak one even by accident. A capped
 * run is a real release and is counted; a ceiling crossing is a report, not a
 * release, and is excluded.
 */
export function provisioningSummary(
  database: DatabaseConnection,
  windowDays: number,
  now: () => Date = () => new Date()
): ProvisioningSummary {
  const generatedAt = now().toISOString();
  const since = new Date(now().getTime() - windowDays * 86_400_000).toISOString();

  const rows = database
    .prepare(
      `SELECT substr(ended_at, 1, 10) AS day,
              release_reason AS reason,
              count(*) AS releases
         FROM sessions
        WHERE ended_at IS NOT NULL
          AND ended_at >= ?
          AND release_reason IS NOT NULL
          AND release_reason <> 'ceiling_reached'
        GROUP BY day, reason
        ORDER BY day DESC, releases DESC`
    )
    .all(since) as Array<{ day: string; reason: ReleaseReason; releases: number }>;

  const byDay = new Map<string, { day: string; total: number; reasons: Array<{ reason: string; count: number }> }>();
  let total = 0;

  for (const row of rows) {
    const entry = byDay.get(row.day) ?? { day: row.day, total: 0, reasons: [] };
    entry.total += row.releases;
    entry.reasons.push({ reason: row.reason, count: row.releases });
    byDay.set(row.day, entry);
    total += row.releases;
  }

  return {
    windowDays,
    generatedAt,
    total,
    days: [...byDay.values()]
  };
}
