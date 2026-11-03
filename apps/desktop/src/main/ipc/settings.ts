import { z } from "zod";
import { settingsUpdateSchema, type AppSettings, type SettingsUpdate } from "@maia/contracts";
import type { IpcRegistry } from "./registry";
import type { SettingsStore } from "../services/settings/store";

export function registerSettingsHandlers(
  registry: IpcRegistry,
  store: SettingsStore,
  onChange?: (settings: AppSettings) => void
): void {
  registry.register("settings.get", z.unknown(), (): AppSettings => store.get());

  registry.register("settings.update", settingsUpdateSchema, (payload: SettingsUpdate): AppSettings => {
    const next = store.update(payload);
    onChange?.(next);
    return next;
  });
}
