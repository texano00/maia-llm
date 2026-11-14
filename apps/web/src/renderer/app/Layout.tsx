import type { ReactNode } from "react";
import { useEffect } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import logoMark from "../assets/logo-mark.png";
import { AccountMenu } from "../shared/auth/AccountMenu";
import { InfoButton } from "../shared/InfoButton";
import { ThemeToggle } from "../shared/theme/ThemeToggle";
import { useWorkspace } from "../shared/session/WorkspaceProvider";
import { useUiPreferences } from "../shared/preferences/useUiPreferences";
import { useProviderHealth } from "../shared/health/useProviderHealth";
import { BalanceBadge } from "../features/notifications/BalanceBadge";
import { NotificationBell } from "../features/notifications/NotificationBell";
import { modelsIndicator } from "../features/models/indicator";

const navigation = [
  { to: "/catalogue", label: "Catalogue" },
  { to: "/models", label: "Models" },
  { to: "/chat", label: "Chat" },
  { to: "/settings", label: "Settings" }
];

export function Layout({ children }: { children: ReactNode }) {
  const { sessions } = useWorkspace();
  const { health } = useProviderHealth();
  const navigate = useNavigate();
  const { acknowledgedFailureIds } = useUiPreferences();

  // Activating a readiness notification brings the app forward on the run list.
  useEffect(() => {
    const unsubscribe = window.maia?.onReadyEvent?.(() => navigate("/models"));
    return () => unsubscribe?.();
  }, [navigate]);

  const indicator = modelsIndicator(sessions, acknowledgedFailureIds);

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
            <ThemeToggle />
            <InfoButton />
            <AccountMenu />
          </div>
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
