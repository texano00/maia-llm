import { HashRouter } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary";
import { Layout } from "./Layout";
import { AppRoutes } from "./routes";
import { UpdatesProvider } from "../shared/updates/UpdatesProvider";

export function App() {
  return (
    <ErrorBoundary>
      <HashRouter>
        <UpdatesProvider>
          <Layout>
            <AppRoutes />
          </Layout>
        </UpdatesProvider>
      </HashRouter>
    </ErrorBoundary>
  );
}
