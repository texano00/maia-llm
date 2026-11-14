import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import type { AppSettings } from "@maia/contracts";

export type Appearance = "light" | "dark";

const STORAGE_KEY = "maia:appearance";

interface ThemeValue {
  appearance: Appearance;
  /** Applies the appearance everywhere; `persist` also writes it to the account. */
  setAppearance(value: Appearance, persist?: boolean): Promise<void>;
  /** Adopts the account's stored value without writing it back. */
  syncFromAccount(): Promise<void>;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function current(): Appearance {
  if (typeof document === "undefined") {
    return "light";
  }

  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function apply(value: Appearance): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = value;
  }

  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, value);
    }
  } catch {
    // Storage can be unavailable; the page still switches for this session.
  }
}

/**
 * Owns the `data-theme` attribute. The first value comes from the pre-paint
 * script in `index.html`; this provider keeps it in sync with the account and
 * with other tabs.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearanceState] = useState<Appearance>(() => current());

  const setAppearance = useCallback(
    async (value: Appearance, persist = true): Promise<void> => {
      apply(value);
      setAppearanceState(value);

      if (!persist) {
        return;
      }

      // Signed out this answers NOT_AUTHENTICATED; the local choice still
      // stands, so the failure is deliberately ignored here.
      await window.maia?.invoke<AppSettings>("settings.update", { appearance: value });
    },
    []
  );

  const syncFromAccount = useCallback(async (): Promise<void> => {
    const result = await window.maia?.invoke<AppSettings>("settings.get");
    if (result?.ok) {
      apply(result.data.appearance);
      setAppearanceState(result.data.appearance);
    }
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== STORAGE_KEY) {
        return;
      }

      const next: Appearance = event.newValue === "dark" ? "dark" : "light";
      apply(next);
      setAppearanceState(next);
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<ThemeValue>(
    () => ({ appearance, setAppearance, syncFromAccount }),
    [appearance, setAppearance, syncFromAccount]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be used inside ThemeProvider");
  }

  return value;
}
