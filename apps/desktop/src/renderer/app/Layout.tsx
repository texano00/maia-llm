import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import logoMark from "../assets/logo-mark.png";
import { InfoButton } from "../shared/InfoButton";
import { UpdateToast } from "../shared/updates/UpdateToast";
import { useWorkspace } from "../shared/session/WorkspaceProvider";
import { useProviderHealth } from "../shared/health/useProviderHealth";
import { BalanceBadge } from "../features/notifications/BalanceBadge";
import { NotificationBell } from "../features/notifications/NotificationBell";
import {
  FAILURES_ACKNOWLEDGED_EVENT,
  modelsIndicator,
  readAcknowledgedFailures
} from "../features/models/indicator";

const navigation = [
  { to: "/catalogue", label: "Catalogue" },
  { to: "/models", label: "Models" },
  { to: "/chat", label: "Chat" },
  { to: "/integrations", label: "IDE" },
  { to: "/settings", label: "Settings" }
];

export function Layout({ children }: { children: ReactNode }) {
  const { sessions } = useWorkspace();
  const { health } = useProviderHealth();
  const navigate = useNavigate();
  const [acknowledged, setAcknowledged] = useState<string[]>(() => readAcknowledgedFailures());

  // Activating a readiness notification brings the app forward on the run list.
  useEffect(() => {
    const unsubscribe = window.maia?.onReadyEvent?.(() => navigate("/models"));
    return () => unsubscribe?.();
  }, [navigate]);

  useEffect(() => {
    const onAcknowledged = (): void => setAcknowledged(readAcknowledgedFailures());
    window.addEventListener(FAILURES_ACKNOWLEDGED_EVENT, onAcknowledged);
    return () => window.removeEventListener(FAILURES_ACKNOWLEDGED_EVENT, onAcknowledged);
  }, []);

  const indicator = modelsIndicator(sessions, acknowledged);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src={logoMark} alt="" aria-hidden="true" />
          <div>
            <strong>Maia LLM</strong>
            <span>Remote GPU studio</span>
          </div>
        </div>

        <nav aria-label="Primary navigation">
          {navigation.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
            >
              {item.label}
              {item.to === "/models" ? (
                <span
                  className={`models-nav-indicator models-nav-${indicator}`}
                  aria-label={
                    indicator === "running"
                      ? "A model is running"
                      : indicator === "failed"
                        ? "A model failed"
                        : "No model running"
                  }
                />
              ) : null}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="content">
        <header className="topbar">
          <div className="topbar-actions">
            <BalanceBadge health={health} />
            <NotificationBell />
            <InfoButton />
          </div>
        </header>
        <main className="page">{children}</main>
        <UpdateToast />
      </div>
    </div>
  );
}
