import type { Session } from "@maia/contracts";

export type ModelsIndicator = "running" | "failed" | "idle";

/** Runs that ended in failure, which is what the red indicator reports. */
export function failedRunIds(runs: Session[]): string[] {
  return runs.filter((run) => run.state === "failed").map((run) => run.id);
}

/**
 * Green while anything is serving; red for a failure the user has not seen;
 * orange otherwise. A running model always wins over a failure.
 */
export function modelsIndicator(
  runs: Session[],
  acknowledged: readonly string[]
): ModelsIndicator {
  if (runs.some((run) => run.state === "active")) {
    return "running";
  }

  const seen = new Set(acknowledged);
  return failedRunIds(runs).some((id) => !seen.has(id)) ? "failed" : "idle";
}

/**
 * Adds newly seen failures to the acknowledged list, keeping the last 200 so the
 * stored preference cannot grow without bound.
 */
export function mergeAcknowledged(existing: readonly string[], ids: readonly string[]): string[] {
  const merged = [...existing];
  for (const id of ids) {
    if (!merged.includes(id)) {
      merged.push(id);
    }
  }

  return merged.slice(-200);
}
