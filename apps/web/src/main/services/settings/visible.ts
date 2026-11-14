import type { AppSettings, Capability, SettingsSnapshot } from "@maia/contracts";

/**
 * Settings that belong to whoever develops the product rather than to the person
 * using it. Everybody gets a working default for both; only an account with
 * `debug` (or `operator`, which implies it) can read or change them.
 */
export const DEVELOPER_SETTING_KEYS = ["diagnosticsUrl", "usageReporting"] as const;

export type DeveloperSettingKey = (typeof DEVELOPER_SETTING_KEYS)[number];

export function isDeveloperCapable(capabilities: readonly Capability[]): boolean {
  return capabilities.includes("debug") || capabilities.includes("operator");
}

/**
 * The projection `settings.get` returns. Hiding the fields in the view alone
 * would leave the payload as a disclosure path, so the keys are removed here.
 */
export function visibleSettings(
  settings: AppSettings,
  capabilities: readonly Capability[]
): SettingsSnapshot {
  if (isDeveloperCapable(capabilities)) {
    return settings;
  }

  const { diagnosticsUrl: _diagnosticsUrl, usageReporting: _usageReporting, ...rest } = settings;
  return rest;
}

/**
 * The configuration document has one shape for everybody, so a projected export
 * is expressed as the full type with the two keys absent. Import treats them as
 * unsupported, which is why the absence is safe.
 */
export function visibleDocumentSettings(
  settings: AppSettings,
  capabilities: readonly Capability[]
): AppSettings {
  return visibleSettings(settings, capabilities) as AppSettings;
}
