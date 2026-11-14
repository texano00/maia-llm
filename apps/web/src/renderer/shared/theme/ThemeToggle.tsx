import { useAuth } from "../auth/AuthProvider";
import { useTheme } from "./ThemeProvider";

/**
 * Top-bar appearance control. Signed in, the choice is stored on the account;
 * on the access page it is a browser-local preference until there is a session.
 */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { appearance, setAppearance } = useTheme();
  const { phase } = useAuth();
  const next = appearance === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-pressed={appearance === "dark"}
      aria-label={next === "dark" ? "Switch to dark appearance" : "Switch to light appearance"}
      title={next === "dark" ? "Dark appearance" : "Light appearance"}
      onClick={() => void setAppearance(next, phase === "signed-in")}
    >
      <span aria-hidden="true">{appearance === "dark" ? "☾" : "☀"}</span>
      {compact ? null : <span className="theme-toggle-label">{appearance === "dark" ? "Dark" : "Light"}</span>}
    </button>
  );
}
