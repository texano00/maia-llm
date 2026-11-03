import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { InfoButton } from "../shared/InfoButton";
import { UpdateToast } from "../shared/updates/UpdateToast";

const navigation = [
  { to: "/catalogue", label: "Catalogue" },
  { to: "/chat", label: "Chat" },
  { to: "/settings", label: "Settings" }
];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
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
