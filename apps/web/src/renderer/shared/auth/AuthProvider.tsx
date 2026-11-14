import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import type { AuthConfig, AuthState } from "@maia/contracts";

type Phase = "loading" | "signed-out" | "signed-in";

interface AuthValue {
  phase: Phase;
  email: string | null;
  config: AuthConfig | null;
  /** Re-reads `auth.state`; returns true when a session is now usable. */
  refresh(): Promise<boolean>;
  signOut(): Promise<boolean>;
  deleteAccount(): Promise<boolean>;
}

const AuthContext = createContext<AuthValue | null>(null);

/**
 * Single source of truth for the signed-in account. Nothing that touches
 * conversations or models renders until `phase` is `signed-in`, so a stale tab
 * cannot fire a burst of `NOT_AUTHENTICATED` calls on boot.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);

  const refresh = useCallback(async (): Promise<boolean> => {
    const bridge = window.maia;
    if (!bridge) {
      setPhase("signed-out");
      return false;
    }

    const result = await bridge.invoke<AuthState>("auth.state");
    if (result.ok && result.data.signedIn) {
      setEmail(result.data.email);
      setPhase("signed-in");
      return true;
    }

    setEmail(null);
    setPhase("signed-out");
    return false;
  }, []);

  useEffect(() => {
    let mounted = true;

    void (async () => {
      const bridge = window.maia;
      if (!bridge) {
        if (mounted) {
          setPhase("signed-out");
        }
        return;
      }

      const configResult = await bridge.invoke<AuthConfig>("auth.config");
      if (mounted && configResult.ok) {
        setConfig(configResult.data);
      }

      if (mounted) {
        await refresh();
      }
    })();

    return () => {
      mounted = false;
    };
  }, [refresh]);

  const signOut = useCallback(async (): Promise<boolean> => {
    const result = await window.maia?.invoke("auth.signOut");
    setEmail(null);
    setPhase("signed-out");
    return result?.ok ?? false;
  }, []);

  const deleteAccount = useCallback(async (): Promise<boolean> => {
    const result = await window.maia?.invoke("auth.deleteAccount", { confirmation: "DELETE" });
    if (result?.ok) {
      setEmail(null);
      setPhase("signed-out");
      return true;
    }

    return false;
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ phase, email, config, refresh, signOut, deleteAccount }),
    [config, deleteAccount, email, phase, refresh, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside AuthProvider");
  }

  return value;
}
