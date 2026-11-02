import { app } from "electron";

export function enforceSingleInstance(): boolean {
  return app.requestSingleInstanceLock();
}

export function registerLifecycleHooks(onBeforeQuit: () => void): void {
  let shuttingDown = false;

  app.on("before-quit", () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    onBeforeQuit();
  });
}
