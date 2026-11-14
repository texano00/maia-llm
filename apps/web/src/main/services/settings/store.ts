import {
  appSettingsSchema,
  DEFAULT_DIAGNOSTICS_URL,
  DEFAULT_GPU_FILTERS,
  DEFAULT_GPU_STARTUP_RETRIES,
  type AppSettings,
  type ConfigurationScope,
  type SettingsUpdate
} from "@maia/contracts";
import type { DatabaseConnection } from "../../storage/db";

/**
 * The diagnostics host before api.maiallm.com existed. A stored value equal to
 * it was almost certainly never chosen by hand, so it follows the new default
 * instead of pinning the install to a localhost service that no longer runs.
 */
const LEGACY_DIAGNOSTICS_URL = "http://localhost:8787";

export const defaultAppSettings: AppSettings = {
  diagnosticsUrl: DEFAULT_DIAGNOSTICS_URL,
  gpuFilters: DEFAULT_GPU_FILTERS,
  gpuStartupRetries: DEFAULT_GPU_STARTUP_RETRIES,
  usageReporting: true,
  walletWarnThresholdMicroUsd: 2_000_000,
  catalogueSupportedOnly: true,
  onboardingCompleted: false,
  onboardingDismissedAt: null,
  dismissedNotificationKeys: [],
  installationId: null,
  appearance: "light",
  catalogueMode: "basic",
  studentMode: false,
  historyOpen: true,
  lastConversationId: null,
  acknowledgedFailureIds: []
};

/**
 * Which fields a scope restores. `all` covers every field; `credentials` is not
 * here because provider secrets live in the credential store, not in settings.
 */
const SCOPE_FIELDS: Record<
  Exclude<ConfigurationScope, "all" | "credentials">,
  Array<keyof AppSettings>
> = {
  appearance: ["appearance"],
  catalogue: ["catalogueMode"],
  chat: ["studentMode", "historyOpen", "lastConversationId"],
  gpu: ["gpuFilters", "gpuStartupRetries"],
  telemetry: ["usageReporting", "walletWarnThresholdMicroUsd", "installationId"],
  onboarding: [
    "onboardingCompleted",
    "onboardingDismissedAt",
    "dismissedNotificationKeys",
    "acknowledgedFailureIds"
  ]
};

function migrate(settings: AppSettings): AppSettings {
  return settings.diagnosticsUrl === LEGACY_DIAGNOSTICS_URL
    ? { ...settings, diagnosticsUrl: DEFAULT_DIAGNOSTICS_URL }
    : settings;
}

/**
 * Small typed wrapper over the `account_settings` table. Values are validated on
 * the way out as well as in, so a hand-edited row can never crash the app.
 */
export class SettingsStore {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly accountId: string
  ) {}

  get(): AppSettings {
    const row = this.database
      .prepare("SELECT value_json FROM account_settings WHERE account_id = ?")
      .get(this.accountId) as { value_json: string } | undefined;

    if (!row) {
      return { ...defaultAppSettings };
    }

    try {
      const parsed = appSettingsSchema.safeParse(JSON.parse(row.value_json));
      return parsed.success ? migrate(parsed.data) : { ...defaultAppSettings };
    } catch {
      return { ...defaultAppSettings };
    }
  }

  update(patch: SettingsUpdate): AppSettings {
    const merged: Record<string, unknown> = { ...this.get() };

    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }

    const next = appSettingsSchema.parse(merged);
    return this.persist(next);
  }

  /**
   * Restores one section (or everything) to the documented defaults. Provider
   * secrets are never touched here: deleting a key is its own explicit scope.
   */
  reset(scope: ConfigurationScope): AppSettings {
    if (scope === "credentials") {
      return this.get();
    }

    const next: Record<string, unknown> = { ...this.get() };
    const keys =
      scope === "all"
        ? (Object.keys(defaultAppSettings) as Array<keyof AppSettings>)
        : SCOPE_FIELDS[scope];

    for (const key of keys) {
      next[key] = defaultAppSettings[key];
    }

    return this.persist(appSettingsSchema.parse(next));
  }

  private persist(next: AppSettings): AppSettings {
    this.database
      .prepare(
        `INSERT INTO account_settings (account_id, value_json, updated_at)
         VALUES (@accountId, @value, @updatedAt)
         ON CONFLICT(account_id) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .run({
        accountId: this.accountId,
        value: JSON.stringify(next),
        updatedAt: new Date().toISOString()
      });

    return next;
  }
}
