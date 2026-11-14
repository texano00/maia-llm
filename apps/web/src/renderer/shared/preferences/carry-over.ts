import type { AppSettings, SettingsUpdate } from "@maia/contracts";

/**
 * One-time move of the preferences that used to live in `localStorage`.
 *
 * It runs after the account's settings are known, fills only fields that are
 * still at their defaults (so a deliberate reset is never undone), and reports
 * the legacy keys to delete. The marker keeps it to a single run per browser.
 */

export const CARRY_OVER_MARKER = "maia:prefs-migrated";

export const LEGACY_KEYS = [
  "maia:catalogue-mode",
  "maia:student-mode",
  "maia:show-reasoning",
  "maia:history-open",
  "maia:last-conversation",
  "maia:acknowledged-failures"
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CarryOverPlan {
  patch: SettingsUpdate;
  /** Legacy keys this browser still had; safe to delete after the write. */
  remove: string[];
}

export function alreadyCarriedOver(read: (key: string) => string | null): boolean {
  return read(CARRY_OVER_MARKER) !== null;
}

export function planCarryOver(
  read: (key: string) => string | null,
  current: AppSettings
): CarryOverPlan {
  const patch: SettingsUpdate = {};
  const remove: string[] = [];

  for (const key of LEGACY_KEYS) {
    if (read(key) !== null) {
      remove.push(key);
    }
  }

  const catalogue = read("maia:catalogue-mode");
  if (catalogue === "advanced" && current.catalogueMode === "basic") {
    patch.catalogueMode = "advanced";
  }

  const student = read("maia:student-mode");
  const legacyReasoning = read("maia:show-reasoning");
  const wantsStudent = student !== null ? student === "true" : legacyReasoning === "true";
  if (wantsStudent && !current.studentMode) {
    patch.studentMode = true;
  }

  if (read("maia:history-open") === "false" && current.historyOpen) {
    patch.historyOpen = false;
  }

  const last = read("maia:last-conversation");
  if (current.lastConversationId === null && last !== null && UUID.test(last)) {
    patch.lastConversationId = last;
  }

  const acknowledged = read("maia:acknowledged-failures");
  if (current.acknowledgedFailureIds.length === 0 && acknowledged !== null) {
    try {
      const parsed: unknown = JSON.parse(acknowledged);
      if (Array.isArray(parsed)) {
        const ids = parsed
          .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
          .slice(-200);
        if (ids.length > 0) {
          patch.acknowledgedFailureIds = ids;
        }
      }
    } catch {
      // A malformed local value is dropped, not carried over.
    }
  }

  return { patch, remove };
}
