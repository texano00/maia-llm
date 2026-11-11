import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import logoMark from "../assets/logo-mark.png";
import { InfoButton } from "../shared/InfoButton";
import { UpdateToast } from "../shared/updates/UpdateToast";

const navigation = [
  { to: "/catalogue", label: "Catalogue" },
  { to: "/models", label: "Models" },
  { to: "/chat", label: "Chat" },
  { to: "/integrations", label: "IDE" },
  { to: "/settings", label: "Settings" }
];

export function Layout({ children }: { children: ReactNode }) {
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
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="content">
        <header className="topbar">
          <InfoButton />
        </header>
        <main className="page">{children}</main>
        <UpdateToast />
      </div>
    </div>
  );
}
