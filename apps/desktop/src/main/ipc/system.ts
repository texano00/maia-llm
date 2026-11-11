import { z } from "zod";
import { notificationDismissSchema } from "@maia/contracts";
import type { ProviderHealthMonitor } from "../services/health/monitor";
import type { NotificationCenter } from "../services/notifications/center";
import type { IpcRegistry } from "./registry";

export interface SystemHandlersOptions {
  registry: IpcRegistry;
  notifications: NotificationCenter;
  health: ProviderHealthMonitor;
}

/**
 * Header surface: the bell snapshot, its dismissals, and the provider readiness
 * snapshot (credentials plus balance). Provider failures are reported as
 * per-provider `unknown` states, not as IPC errors, so the header can still show
 * everything else that is known.
 */
export function registerSystemHandlers(options: SystemHandlersOptions): void {
  const { registry, notifications, health } = options;

  registry.register("notifications.list", z.unknown(), () => notifications.snapshot());

  registry.register("notifications.dismiss", notificationDismissSchema, (payload) =>
    notifications.dismiss(payload.key)
  );

  registry.register("provider.health", z.unknown(), async () => health.refresh());
}
