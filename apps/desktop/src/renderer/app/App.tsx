import { HashRouter } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary";
import { Layout } from "./Layout";
import { AppRoutes } from "./routes";
import { UpdatesProvider } from "../shared/updates/UpdatesProvider";
import { WorkspaceProvider } from "../shared/session/WorkspaceProvider";

export function App() {
  return (
    <ErrorBoundary>
      <HashRouter>
        <UpdatesProvider>
          <WorkspaceProvider>
            <Layout>
              <AppRoutes />
            </Layout>
          </WorkspaceProvider>
        </UpdatesProvider>
      </HashRouter>
    </ErrorBoundary>
  );
}
