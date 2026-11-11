import type { Session } from "@maia/contracts";

export type ModelsIndicator = "running" | "failed" | "idle";

const STORAGE_KEY = "maia:acknowledged-failures";
export const FAILURES_ACKNOWLEDGED_EVENT = "maia:failures-acknowledged";

/** Runs that ended in failure, which is what the red indicator reports. */
export function failedRunIds(runs: Session[]): string[] {
  return runs.filter((run) => run.state === "failed").map((run) => run.id);
}

/**
 * Green while anything is serving; red for a failure the user has not seen;
 * orange otherwise. A running model always wins over a failure.
 */
export function modelsIndicator(runs: Session[], acknowledged: readonly string[]): ModelsIndicator {
  if (runs.some((run) => run.state === "active")) {
    return "running";
  }

  const seen = new Set(acknowledged);
  return failedRunIds(runs).some((id) => !seen.has(id)) ? "failed" : "idle";
}

export function readAcknowledgedFailures(): string[] {
  if (typeof localStorage === "undefined") {
    return [];
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** Called by the Models page when it is opened. */
export function acknowledgeFailures(ids: readonly string[]): void {
  if (ids.length === 0 || typeof localStorage === "undefined") {
    return;
  }

  const seen = readAcknowledgedFailures();
  const missing = ids.filter((id) => !seen.includes(id));
  if (missing.length === 0) {
    return;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify([...seen, ...missing].slice(-200)));
  window.dispatchEvent(new Event(FAILURES_ACKNOWLEDGED_EVENT));
}
