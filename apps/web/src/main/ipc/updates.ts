import { z } from "zod";
import type { UpdateStatus } from "@maia/contracts";
import type { IpcRegistry } from "./registry";
import type { UpdateService } from "../services/updates/updater";

/**
 * Exposes the update lifecycle to the renderer. All handlers resolve with the
 * full status so the UI never has to guess the outcome of an action.
 */
export function registerUpdateHandlers(registry: IpcRegistry, service: UpdateService): void {
  registry.register("update.status", z.unknown(), (): UpdateStatus => service.getStatus());

  registry.register("update.check", z.unknown(), async (): Promise<UpdateStatus> => {
    return service.check();
  });

  registry.register("update.download", z.unknown(), async (): Promise<UpdateStatus> => {
    return service.download();
  });

  registry.register("update.install", z.unknown(), (): UpdateStatus => {
    return service.install();
  });
}
