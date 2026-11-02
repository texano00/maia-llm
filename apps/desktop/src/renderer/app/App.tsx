import { HashRouter } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary";
import { Layout } from "./Layout";
import { AppRoutes } from "./routes";

export function App() {
  return (
    <ErrorBoundary>
      <HashRouter>
        <Layout>
          <AppRoutes />
        </Layout>
      </HashRouter>
    </ErrorBoundary>
  );
}
