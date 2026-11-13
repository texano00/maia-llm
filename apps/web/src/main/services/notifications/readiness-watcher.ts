import type { Session } from "@maia/contracts";
import type { ReadinessNotifier } from "./desktop";

export interface ReadinessWatcherOptions {
  listSessions: () => Session[];
  notifier: ReadinessNotifier;
  intervalMs?: number;
}

/**
 * Watches session state in the main process so a run that becomes ready while
 * the user is in another application produces exactly one notification. Polling
 * (2 s) is used because the orchestrator has no lifecycle event channel today;
 * it reads the same in-memory list the renderer already polls.
 */
export class ReadinessWatcher {
  private readonly seen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: ReadinessWatcherOptions) {}

  tick(): void {
    for (const session of this.options.listSessions()) {
      if (session.state !== "active" || this.seen.has(session.id)) {
        continue;
      }

      this.seen.add(session.id);
      this.options.notifier.notifyReady({ id: session.id, modelId: session.modelId });
    }
  }

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.options.intervalMs ?? 2_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
