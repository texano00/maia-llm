import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

// Each screen is its own chunk: the catalogue renders without parsing the chat
// transcript code or the settings forms.
const CataloguePage = lazy(() =>
  import("../features/catalogue/CataloguePage").then((module) => ({
    default: module.CataloguePage
  }))
);
const ChatPage = lazy(() =>
  import("../features/chat/ChatPage").then((module) => ({ default: module.ChatPage }))
);
const IntegrationPage = lazy(() =>
  import("../features/ide-integration/IntegrationPage").then((module) => ({
    default: module.IntegrationPage
  }))
);
const SettingsPage = lazy(() =>
  import("../features/settings/SettingsPage").then((module) => ({
    default: module.SettingsPage
  }))
);

export function AppRoutes() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <Routes>
        <Route path="/" element={<Navigate to="/catalogue" replace />} />
        <Route path="/catalogue" element={<CataloguePage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/integrations" element={<IntegrationPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/catalogue" replace />} />
      </Routes>
    </Suspense>
  );
}
