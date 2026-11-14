import { useSyncExternalStore } from "react";
import {
  preferencesSnapshot,
  subscribePreferences,
  type UiPreferences
} from "./store";

/** Reactive view of the account's UI preferences. */
export function useUiPreferences(): UiPreferences {
  return useSyncExternalStore(subscribePreferences, preferencesSnapshot, preferencesSnapshot);
}
