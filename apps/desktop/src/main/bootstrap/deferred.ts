import type { AppLoggerLike } from "./logging";

export interface DeferredTask {
  /** Stable name, used in the log line when the task fails. */
  name: string;
  run: () => Promise<void> | void;
}

/**
 * Start-up work that is not needed to paint the first screen.
 *
 * It is deliberately isolated per task: a guardian that cannot write its state
 * file or an update check that times out must never take the app down, and must
 * never delay the window either — the caller fires this after the first paint
 * and does not await it.
 */
export async function runDeferredStartup(
  tasks: readonly DeferredTask[],
  log?: Pick<AppLoggerLike, "warn">
): Promise<void> {
  for (const task of tasks) {
    try {
      await task.run();
    } catch (error) {
      log?.warn("Deferred start-up task failed", {
        task: task.name,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

/**
 * Wires "do this after the first paint" without letting the paint wait for it.
 * Returns a promise that settles when the deferred work is scheduled, not done.
 */
export function afterFirstPaint(
  painted: Promise<void>,
  tasks: readonly DeferredTask[],
  log?: Pick<AppLoggerLike, "warn">
): void {
  void painted.then(() => runDeferredStartup(tasks, log)).catch(() => undefined);
}
