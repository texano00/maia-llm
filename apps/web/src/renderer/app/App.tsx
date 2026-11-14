import { HashRouter } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary";
import { Layout } from "./Layout";
import { AppRoutes } from "./routes";
import { AuthProvider, useAuth } from "../shared/auth/AuthProvider";
import { WorkspaceProvider } from "../shared/session/WorkspaceProvider";
import { OnboardingGate } from "../features/onboarding/OnboardingGate";
import { AccessPage } from "../features/access/AccessPage";

export function App() {
  return (
    <ErrorBoundary>
      <HashRouter>
        <AuthProvider>
          <AuthGate />
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
