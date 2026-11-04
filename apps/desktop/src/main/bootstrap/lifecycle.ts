import { app } from "electron";
import type { QuitCoordinator } from "./quit";

export function enforceSingleInstance(): boolean {
  return app.requestSingleInstanceLock();
}

/**
 * Routes every quit through the coordinator: Electron asks "may I quit?", the
 * coordinator warns about the GPUs that are about to be destroyed, releases
 * them, and only then calls `app.quit()` again.
 */
export function registerLifecycleHooks(quit: QuitCoordinator): void {
  app.on("before-quit", (event) => {
    if (quit.intercept()) {
      event.preventDefault();
    }
  });
}
