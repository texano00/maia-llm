import {
  appSettingsSchema,
  DEFAULT_DIAGNOSTICS_URL,
  DEFAULT_GPU_FILTERS,
  DEFAULT_GPU_STARTUP_RETRIES,
  DEFAULT_IDE_ENDPOINT_PORT,
  type AppSettings,
  type SettingsUpdate
} from "@maia/contracts";
import type { DatabaseConnection } from "../../storage/db";

const SETTINGS_KEY = "app_settings";

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
  ideEndpointEnabled: false,
  ideEndpointPort: DEFAULT_IDE_ENDPOINT_PORT
};

function migrate(settings: AppSettings): AppSettings {
  return settings.diagnosticsUrl === LEGACY_DIAGNOSTICS_URL
    ? { ...settings, diagnosticsUrl: DEFAULT_DIAGNOSTICS_URL }
    : settings;
}

/**
 * Small typed wrapper over the `preferences` table. Values are validated on the
 * way out as well as in, so a hand-edited row can never crash the app.
 */
export class SettingsStore {
  constructor(private readonly database: DatabaseConnection) {}

  get(): AppSettings {
    const row = this.database
      .prepare("SELECT value_json FROM preferences WHERE key = ?")
      .get(SETTINGS_KEY) as { value_json: string } | undefined;

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

    this.database
      .prepare(
        `INSERT INTO preferences (key, value_json, updated_at)
         VALUES (@key, @value, @updatedAt)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run({ key: SETTINGS_KEY, value: JSON.stringify(next), updatedAt: new Date().toISOString() });

    return next;
  }
}
