import { useEffect } from "react";
import type { AppSettings } from "@maia/contracts";
import { HashRouter } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary";
import { Layout } from "./Layout";
import { AppRoutes } from "./routes";
import { AuthProvider, useAuth } from "../shared/auth/AuthProvider";
import { ThemeProvider, useTheme } from "../shared/theme/ThemeProvider";
import { WorkspaceProvider } from "../shared/session/WorkspaceProvider";
import { OnboardingGate } from "../features/onboarding/OnboardingGate";
import { AccessPage } from "../features/access/AccessPage";
import { hydratePreferences } from "../shared/preferences/store";
import {
  CARRY_OVER_MARKER,
  alreadyCarriedOver,
  planCarryOver
} from "../shared/preferences/carry-over";

export function App() {
  return (
    <ErrorBoundary>
      <HashRouter>
        <AuthProvider>
          <ThemeProvider>
            <AuthGate />
          </ThemeProvider>
        </AuthProvider>
      </HashRouter>
    </ErrorBoundary>
  );
}

/**
 * Nothing that reads account data mounts before a session exists: the catalogue
 * and session graphs would otherwise fire a burst of `NOT_AUTHENTICATED` calls
 * on every visit to the access page.
 */
function AuthGate() {
  const { phase } = useAuth();
  const { syncFromAccount } = useTheme();

  // The account is the source of truth for appearance and UI preferences.
  useEffect(() => {
    if (phase !== "signed-in") {
      return;
    }

    void (async () => {
      await syncFromAccount();

      const result = await window.maia?.invoke<AppSettings>("settings.get");
      if (!result?.ok) {
        return;
      }

      hydratePreferences(result.data);

      let storage: Storage | null = null;
      try {
        storage = window.localStorage;
      } catch {
        storage = null;
      }

      if (!storage) {
        return;
      }

      const read = (key: string): string | null => storage!.getItem(key);
      if (alreadyCarriedOver(read)) {
        return;
      }

      // Browser preferences from before this feature move onto the account once.
      const plan = planCarryOver(read, result.data);
      if (Object.keys(plan.patch).length > 0) {
        const updated = await window.maia?.invoke<AppSettings>("settings.update", plan.patch);
        if (updated?.ok) {
          hydratePreferences(updated.data);
        }
      }

      storage.setItem(CARRY_OVER_MARKER, "1");
      for (const key of plan.remove) {
        storage.removeItem(key);
      }
    })();
  }, [phase, syncFromAccount]);

  if (phase === "loading") {
    return (
      <div className="access-shell">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (phase === "signed-out") {
    return <AccessPage />;
  }

  return (
    <WorkspaceProvider>
      <Layout>
        <AppRoutes />
      </Layout>
      <OnboardingGate />
    </WorkspaceProvider>
  );
}
