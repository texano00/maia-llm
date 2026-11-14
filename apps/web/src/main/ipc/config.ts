import { z } from "zod";
import {
  configImportSchema,
  configResetSchema,
  type ConfigImportResult,
  type ConfigResetResult,
  type ConfigurationDocument
} from "@maia/contracts";
import type { IpcRegistry } from "./registry";
import type { SettingsStore } from "../services/settings/store";
import type { CredentialStore } from "../services/credentials/store";
import { buildConfigurationDocument, planImport } from "../services/config/document";

export interface ConfigHandlersOptions {
  registry: IpcRegistry;
  settings: SettingsStore;
  credentials: CredentialStore;
}

/**
 * Configuration read/export/import/reset for one account. The document is the
 * same object for `get` and `export`, so a person's own tooling and the settings
 * screen cannot drift apart.
 */
export function registerConfigHandlers(options: ConfigHandlersOptions): void {
  const { registry, settings, credentials } = options;

  const document = (): ConfigurationDocument =>
    buildConfigurationDocument(settings.get(), credentials.snapshot());

  registry.register("config.get", z.unknown(), (): ConfigurationDocument => document());

  registry.register("config.export", z.unknown(), (): ConfigurationDocument => document());

  registry.register("config.import", configImportSchema, (payload): ConfigImportResult => {
    const plan = planImport(settings.get(), payload.document);
    const next = Object.keys(plan.patch).length > 0 ? settings.update(plan.patch) : settings.get();

    return { settings: next, applied: plan.applied, skipped: plan.skipped };
  });

  registry.register(
    "config.reset",
    configResetSchema,
    async (payload): Promise<ConfigResetResult> => {
      // Settings and secrets are reset separately on purpose: `all` must not
      // silently destroy provider keys.
      if (payload.scope === "credentials") {
        await credentials.removeAll();
        return { settings: settings.get(), credentialsCleared: true };
      }

      return { settings: settings.reset(payload.scope), credentialsCleared: false };
    }
  );
}
