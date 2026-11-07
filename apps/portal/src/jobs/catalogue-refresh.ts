import type { SnapshotService } from "../services/catalogue/snapshot-service.js";

export interface CatalogueRefreshJobOptions {
  service: SnapshotService;
  /** Default 6 hours; deployment can shorten or lengthen it. */
  intervalMs: number;
  /** Delay before the first pass so boot is not blocked by a network round-trip. */
  initialDelayMs?: number;
  logger?: { info(message: string): void; warn(message: string): void };
}

/**
 * Keeps the snapshot fresh without a scheduler dependency.
 *
 * `setInterval` on an unref'd timer is enough for one process: a missed pass (the
 * process was down) simply runs at the next boot, and a manual forced refresh
 * from the backoffice covers "now".
 */
export function startCatalogueRefreshJob(options: CatalogueRefreshJobOptions): { stop(): void } {
  let stopped = false;

  const run = (trigger: "scheduled" | "manual"): void => {
    if (stopped) {
      return;
    }

    void options.service.refresh(trigger).then((result) => {
      if (result.outcome === "failed") {
        options.logger?.warn(`Scheduled catalogue refresh failed: ${result.error ?? "unknown error"}`);
      }
    });
  };

  const initial = setTimeout(() => run("scheduled"), options.initialDelayMs ?? 5_000);
  initial.unref?.();

  const timer = setInterval(() => run("scheduled"), options.intervalMs);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearTimeout(initial);
      clearInterval(timer);
    }
  };
}
