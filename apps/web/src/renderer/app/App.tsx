import { HashRouter } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary";
import { Layout } from "./Layout";
import { AppRoutes } from "./routes";
import { UpdatesProvider } from "../shared/updates/UpdatesProvider";
import { WorkspaceProvider } from "../shared/session/WorkspaceProvider";
import { OnboardingGate } from "../features/onboarding/OnboardingGate";

export function App() {
  return (
    <ErrorBoundary>
      <HashRouter>
        <UpdatesProvider>
          <WorkspaceProvider>
            <Layout>
              <AppRoutes />
            </Layout>
            <OnboardingGate />
          </WorkspaceProvider>
        </UpdatesProvider>
      </HashRouter>
    </ErrorBoundary>
  );
}
