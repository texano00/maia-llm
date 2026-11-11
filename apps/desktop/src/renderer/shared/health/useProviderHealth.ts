import { useCallback, useEffect, useState } from "react";
import type { ProviderHealth } from "@maia/contracts";

export interface ProviderHealthValue {
  health: ProviderHealth | null;
  reload: () => Promise<void>;
}

/** Shared snapshot for the header, the balance badge and missing-key prompts. */
export function useProviderHealth(): ProviderHealthValue {
  const [health, setHealth] = useState<ProviderHealth | null>(null);

  const reload = useCallback(async () => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    const result = await bridge.invoke<ProviderHealth>("provider.health");
    if (result.ok) {
      setHealth(result.data);
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      void reload();
    }, 5_000);
    const onVisible = (): void => {
      if (!document.hidden) {
        void reload();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  return { health, reload };
}
