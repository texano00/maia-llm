import { Navigate, Route, Routes } from "react-router-dom";
import { CataloguePage } from "../features/catalogue/CataloguePage";
import { ChatPage } from "../features/chat/ChatPage";
import { HistoryPage } from "../features/history/HistoryPage";
import { SettingsPage } from "../features/settings/SettingsPage";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/catalogue" replace />} />
      <Route path="/catalogue" element={<CataloguePage />} />
      <Route path="/chat" element={<ChatPage />} />
      <Route path="/history" element={<HistoryPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/catalogue" replace />} />
    </Routes>
  );
}
