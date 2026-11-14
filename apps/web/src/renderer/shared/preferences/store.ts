import type { AppSettings, SettingsUpdate } from "@maia/contracts";

/**
 * UI preferences are account data now (specs/006-theme-and-user-config). This
 * module gives the renderer a synchronous read and a single write path, then
 * syncs the authoritative answer back from the server.
 *
 * Reads fall back to the values the product used before the move, so a screen
 * can render before `settings.get` answers without flickering to something else.
 */

export interface UiPreferences {
  catalogueMode: "basic" | "advanced";
  studentMode: boolean;
  historyOpen: boolean;
  lastConversationId: string | null;
  acknowledgedFailureIds: string[];
}

export const FALLBACK_PREFERENCES: UiPreferences = {
  catalogueMode: "basic",
  studentMode: false,
  historyOpen: true,
  lastConversationId: null,
  acknowledgedFailureIds: []
};

function pick(settings: AppSettings): UiPreferences {
  return {
    catalogueMode: settings.catalogueMode,
    studentMode: settings.studentMode,
    historyOpen: settings.historyOpen,
    lastConversationId: settings.lastConversationId,
    acknowledgedFailureIds: settings.acknowledgedFailureIds
  };
}

let snapshot: UiPreferences = FALLBACK_PREFERENCES;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribePreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function preferencesSnapshot(): UiPreferences {
  return snapshot;
}

/** Called once after sign-in with the account's stored settings. */
export function hydratePreferences(settings: AppSettings): void {
  snapshot = pick(settings);
  emit();
}

/** Optimistic write; the server's answer replaces the snapshot when it lands. */
export function updatePreferences(patch: SettingsUpdate): void {
  const merged: UiPreferences = { ...snapshot };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && key in merged) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }

  snapshot = merged;
  emit();

  void window.maia?.invoke<AppSettings>("settings.update", patch).then((result) => {
    if (result?.ok) {
      snapshot = pick(result.data);
      emit();
    }
  });
}
