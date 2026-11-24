import { useCallback, useEffect, useState } from "react";
import type { ProviderHealth } from "@maia/contracts";

export interface ProviderHealthValue {
  health: ProviderHealth | null;
  reload: () => Promise<void>;
}

/**
 * One read at a time, shared by every component that asks.
 *
 * The header and the catalogue both mount this hook, and each used to poll on
 * its own — the same answer twice every five seconds. The snapshot is per tab,
 * not per component, so one in-flight read serves them all.
 */
let sharedRead: Promise<ProviderHealth | null> | null = null;

function readHealthOnce(): Promise<ProviderHealth | null> {
  const bridge = window.maia;
  if (!bridge) {
    return Promise.resolve(null);
  }

  if (!sharedRead) {
    sharedRead = bridge
      .invoke<ProviderHealth>("provider.health")
      .then((result) => (result.ok ? result.data : null))
      .finally(() => {
        sharedRead = null;
      });
  }

  return sharedRead;
}

/** Shared snapshot for the header, the balance badge and missing-key prompts. */
export function useProviderHealth(): ProviderHealthValue {
  const [health, setHealth] = useState<ProviderHealth | null>(null);

  const reload = useCallback(async () => {
    const next = await readHealthOnce();
    if (next) {
      setHealth(next);
    }
  }, []);

  useEffect(() => {
    void reload();
    // Credentials and balance change on a human timescale; the host caches the
    // provider checks for twenty seconds anyway.
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      void reload();
    }, 30_000);
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
