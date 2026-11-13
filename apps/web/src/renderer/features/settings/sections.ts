export const SETTINGS_SECTIONS = [
  "updates",
  "vastai",
  "huggingface",
  "gpu",
  "diagnostics",
  "usage"
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

/**
 * Every section starts collapsed: the screen is a scannable list, not a wall of
 * fields. Expansion is component state and is deliberately not persisted, so
 * each visit starts from the same overview.
 */
export function initialExpanded(sectionWithError: SettingsSectionId | null = null): SettingsSectionId[] {
  return sectionWithError ? [sectionWithError] : [];
}

export function toggleSection(
  expanded: readonly SettingsSectionId[],
  id: SettingsSectionId
): SettingsSectionId[] {
  return expanded.includes(id) ? expanded.filter((entry) => entry !== id) : [...expanded, id];
}

export function isExpanded(expanded: readonly SettingsSectionId[], id: SettingsSectionId): boolean {
  return expanded.includes(id);
}

/**
 * A validation failure should not be hidden inside a collapsed card. The message
 * decides which section opens; unknown messages open nothing.
 */
export function sectionForError(message: string | null): SettingsSectionId | null {
  if (!message) {
    return null;
  }

  const lower = message.toLowerCase();
  if (lower.includes("gpu") || lower.includes("retries") || lower.includes("wallet") || lower.includes("threshold")) {
    return "gpu";
  }
  if (lower.includes("url") || lower.includes("host")) {
    return "diagnostics";
  }
  if (lower.includes("hugging")) {
    return "huggingface";
  }
  if (lower.includes("vast")) {
    return "vastai";
  }

  return null;
}
