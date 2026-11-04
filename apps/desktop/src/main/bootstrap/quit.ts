export interface RunningGpuSummary {
  /** Number of sessions that still hold a rented instance. */
  count: number;
  /** One line per GPU, shown in the confirmation dialog. */
  detail: string;
}

export interface QuitCoordinatorOptions {
  /** Snapshot of what is about to be destroyed, used for the warning. */
  describeRunningGpus: () => RunningGpuSummary;
  /** Asks the user. Resolves true to quit, false to keep the app open. */
  confirm: (summary: RunningGpuSummary) => Promise<boolean>;
  /** Releases every rented GPU. Awaited, with a deadline. */
  releaseGpus: () => Promise<void>;
  /** Stops timers, flushes logs, closes the database. Must not throw. */
  dispose: () => void;
  /** Called once the GPUs are released and cleanup finished. */
  quit: () => void;
  /** Upper bound on the release step, so a hung request cannot block exit. */
  releaseTimeoutMs?: number;
  logger?: { warn(message: string, context?: Record<string, unknown>): void } | undefined;
}

/**
 * Owns the "the app is closing" sequence.
 *
 * Both `before-quit` and the window's `close` event route through
 * {@link intercept}: while the coordinator is working it answers "keep the app
 * open", and only the final `quit()` lets Electron continue. That is what turns
 * the old fire-and-forget `void sessions.endAll(...)` into a teardown that has
 * actually finished before the process exits.
 */
export class QuitCoordinator {
  private state: "running" | "working" | "finished" = "running";

  constructor(private readonly options: QuitCoordinatorOptions) {}

  /**
   * Returns true when the caller must cancel the close/quit because the
   * coordinator is handling it.
   */
  intercept(): boolean {
    if (this.state === "finished") {
      return false;
    }

    if (this.state === "running") {
      this.state = "working";
      void this.run();
    }

    return true;
  }

  private async run(): Promise<void> {
    const summary = this.options.describeRunningGpus();

    if (summary.count > 0) {
      const proceed = await this.options.confirm(summary).catch(() => false);
      if (!proceed) {
        this.state = "running";
        return;
      }
    }

    try {
      await Promise.race([
        this.options.releaseGpus(),
        new Promise((resolve) =>
          setTimeout(resolve, this.options.releaseTimeoutMs ?? 20_000).unref?.(),
        ),
      ]);
    } catch (error) {
      this.options.logger?.warn("Releasing GPUs during shutdown failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      this.options.dispose();
    } catch (error) {
      this.options.logger?.warn("Shutdown cleanup failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    this.state = "finished";
    this.options.quit();
  }
}
