import type { Capability } from "@maia/contracts";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./sections";

/**
 * Two settings sections are for developers: the diagnostics host and the usage
 * sample. Everyone else keeps the default (a working diagnostics host and a
 * usage sample they can switch off), they simply do not see the controls — and
 * the server does not send the values either.
 */
const DEVELOPER_SECTIONS: readonly SettingsSectionId[] = ["diagnostics", "usage"];

export function isDeveloperSection(id: SettingsSectionId): boolean {
  return DEVELOPER_SECTIONS.includes(id);
}

export function isVisibleSection(
  id: SettingsSectionId,
  capabilities: readonly Capability[]
): boolean {
  if (!isDeveloperSection(id)) {
    return true;
  }

  return capabilities.includes("debug") || capabilities.includes("operator");
}

/** Reads `?section=…` and returns it only when it names a real section. */
export function requestedSection(search: string): SettingsSectionId | null {
  const requested = new URLSearchParams(search).get("section");
  if (!requested) {
    return null;
  }

  return (SETTINGS_SECTIONS as readonly string[]).includes(requested)
    ? (requested as SettingsSectionId)
    : null;
}
