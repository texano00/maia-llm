import { z } from "zod";
import {
  configImportSchema,
  configResetSchema,
  type Capability,
  type ConfigImportResult,
  type ConfigResetResult,
  type ConfigurationDocument
} from "@maia/contracts";
import type { IpcRegistry } from "./registry";
import type { SettingsStore } from "../services/settings/store";
import type { CredentialStore } from "../services/credentials/store";
import { buildConfigurationDocument, planImport } from "../services/config/document";
import {
  DEVELOPER_SETTING_KEYS,
  isDeveloperCapable,
  visibleDocumentSettings
} from "../services/settings/visible";

export interface ConfigHandlersOptions {
  registry: IpcRegistry;
  settings: SettingsStore;
  credentials: CredentialStore;
  /** The account's effective capabilities; late-bound so a grant applies at once. */
  capabilities?: (() => readonly Capability[]) | undefined;
}

/**
 * Configuration read/export/import/reset for one account. The document is the
 * same object for `get` and `export`, so a person's own tooling and the settings
 * screen cannot drift apart — and it is built from the same projection the
 * settings screen sees.
 */
export function registerConfigHandlers(options: ConfigHandlersOptions): void {
  const { registry, settings, credentials } = options;
  const capabilities = (): readonly Capability[] => options.capabilities?.() ?? [];

  const document = (): ConfigurationDocument =>
    buildConfigurationDocument(
      visibleDocumentSettings(settings.get(), capabilities()),
      credentials.snapshot()
    );

  registry.register("config.get", z.unknown(), (): ConfigurationDocument => document());

  registry.register("config.export", z.unknown(), (): ConfigurationDocument => document());

  registry.register("config.import", configImportSchema, (payload): ConfigImportResult => {
    const unsupported = isDeveloperCapable(capabilities()) ? [] : DEVELOPER_SETTING_KEYS;
    const plan = planImport(settings.get(), payload.document, unsupported);
    const next = Object.keys(plan.patch).length > 0 ? settings.update(plan.patch) : settings.get();

    return {
      settings: visibleDocumentSettings(next, capabilities()),
      applied: plan.applied,
      skipped: plan.skipped
    };
  });

  registry.register(
    "config.reset",
    configResetSchema,
    async (payload): Promise<ConfigResetResult> => {
      // Settings and secrets are reset separately on purpose: `all` must not
      // silently destroy provider keys.
      if (payload.scope === "credentials") {
        await credentials.removeAll();
        return {
          settings: visibleDocumentSettings(settings.get(), capabilities()),
          credentialsCleared: true
        };
      }

      return {
        settings: visibleDocumentSettings(settings.reset(payload.scope), capabilities()),
        credentialsCleared: false
      };
    }
  );
}
