import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

const navigation = [
  { to: "/catalogue", label: "Catalogue" },
  { to: "/chat", label: "Chat" },
  { to: "/history", label: "History" },
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
          <span className="status-pill">
            <span className="status-dot" aria-hidden="true" />
            Foundation
          </span>
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
