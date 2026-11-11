import type { Session } from "@maia/contracts";

/**
 * Combines the active-session list with locally persisted history into one
 * Models list. The same run can appear in both reads while it is ending, so
 * entries are keyed by session id (active wins) and sorted newest first.
 */
export function mergeRuns(active: Session[], history: Session[]): Session[] {
  const byId = new Map<string, Session>();

  for (const run of history) {
    byId.set(run.id, run);
  }
  for (const run of active) {
    byId.set(run.id, run);
  }

  return [...byId.values()].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}
