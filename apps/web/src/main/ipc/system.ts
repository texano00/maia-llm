import { z } from "zod";
import { notificationClaimSchema, notificationDismissSchema } from "@maia/contracts";
import type { ProviderHealthMonitor } from "../services/health/monitor";
import type { NotificationCenter } from "../services/notifications/center";
import type { IpcRegistry } from "./registry";

export interface SystemHandlersOptions {
  registry: IpcRegistry;
  notifications: NotificationCenter;
  health: ProviderHealthMonitor;
  /** Called after each refresh so the bell reflects the latest checks. */
  onHealth?: ((snapshot: Awaited<ReturnType<ProviderHealthMonitor["refresh"]>>) => void) | undefined;
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

  // Claim-once: the toast shows an entry only the first time it is claimed, so a
  // second tab, a reload or another device stays quiet (FR-015).
  registry.register("notifications.claim", notificationClaimSchema, (payload) => ({
    shown: notifications.claim(payload.key),
    snapshot: notifications.snapshot()
  }));

  registry.register("provider.health", z.unknown(), async () => {
    const snapshot = await health.refresh();
    options.onHealth?.(snapshot);
    return snapshot;
  });
}
