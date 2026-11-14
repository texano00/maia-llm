import type { CredentialCheck, ProviderHealth } from "@maia/contracts";
import type { NotificationInput } from "../notifications/center";

export interface ProviderHealthSources {
  /** Presence is enough to know a key exists; verification is optional. */
  hasHuggingFace: () => Promise<boolean>;
  verifyHuggingFace?: (() => Promise<boolean>) | undefined;
  hasVastai: () => Promise<boolean>;
  verifyVastai?: (() => Promise<boolean>) | undefined;
  /** Null when the balance cannot be read (offline, outage, missing key). */
  getBalanceMicroUsd: () => Promise<number | null>;
  getThresholdMicroUsd: () => number;
  /**
   * The header polls every few seconds; this bounds how often the sources (and
   * therefore the providers) are actually asked. `0` checks on every refresh.
   */
  minIntervalMs?: number;
  now?: () => Date;
}

/**
 * Provider readiness snapshot used by the header bell and the balance badge.
 * Checks never throw: an unreachable provider is reported as `unknown`, and an
 * unreadable balance is never rendered as zero.
 */
export class ProviderHealthMonitor {
  private readonly now: () => Date;
  private readonly minIntervalMs: number;
  private value: ProviderHealth;
  private lastCheckedAt = 0;
  /** Bumped by `invalidate`, so a slower in-flight check cannot overwrite a newer one. */
  private generation = 0;
  private inFlight: { generation: number; promise: Promise<ProviderHealth> } | null = null;

  constructor(private readonly sources: ProviderHealthSources) {
    this.now = sources.now ?? (() => new Date());
    this.minIntervalMs = sources.minIntervalMs ?? 0;
    this.value = this.unknownSnapshot();
  }

  current(): ProviderHealth {
    return this.value;
  }

  /** Called after a credential change so the next read is not cached. */
  invalidate(): void {
    this.lastCheckedAt = 0;
    this.generation += 1;
  }

  async refresh(): Promise<ProviderHealth> {
    // Concurrent callers share one check: the header polls, and a credential save
    // triggers a read of its own.
    if (this.inFlight && this.inFlight.generation === this.generation) {
      return this.inFlight.promise;
    }

    const startedAt = this.now().getTime();
    if (this.minIntervalMs > 0 && this.lastCheckedAt > 0 && startedAt - this.lastCheckedAt < this.minIntervalMs) {
      return this.value;
    }

    const generation = this.generation;
    this.lastCheckedAt = startedAt;
    const promise = this.check(generation);
    this.inFlight = { generation, promise };
    try {
      return await promise;
    } finally {
      if (this.inFlight?.promise === promise) {
        this.inFlight = null;
      }
    }
  }

  private async check(generation: number): Promise<ProviderHealth> {
    const checkedAt = this.now().toISOString();
    const [huggingface, vastai, balance] = await Promise.all([
      this.checkCredential(this.sources.hasHuggingFace, this.sources.verifyHuggingFace, checkedAt),
      this.checkCredential(this.sources.hasVastai, this.sources.verifyVastai, checkedAt),
      this.readBalance(checkedAt)
    ]);

    const next: ProviderHealth = {
      huggingface,
      vastai,
      balance,
      thresholdMicroUsd: this.sources.getThresholdMicroUsd()
    };

    // A check that started before an `invalidate` is stale by definition: the key
    // it read may have been replaced while it ran.
    if (generation === this.generation) {
      this.value = next;
    }

    return this.value;
  }

  private async checkCredential(
    has: () => Promise<boolean>,
    verify: (() => Promise<boolean>) | undefined,
    checkedAt: string
  ): Promise<CredentialCheck> {
    try {
      if (!(await has())) {
        return { state: "missing", checkedAt };
      }
      if (!verify) {
        return { state: "unknown", checkedAt };
      }

      return { state: (await verify()) ? "ok" : "invalid", checkedAt };
    } catch {
      return { state: "unknown", checkedAt };
    }
  }

  private async readBalance(checkedAt: string): Promise<ProviderHealth["balance"]> {
    try {
      const amount = await this.sources.getBalanceMicroUsd();
      return amount === null
        ? { state: "unknown", amountMicroUsd: null, checkedAt }
        : { state: "known", amountMicroUsd: amount, checkedAt };
    } catch {
      return { state: "unknown", amountMicroUsd: null, checkedAt };
    }
  }

  private unknownSnapshot(): ProviderHealth {
    const checkedAt = this.now().toISOString();
    return {
      huggingface: { state: "unknown", checkedAt },
      vastai: { state: "unknown", checkedAt },
      balance: { state: "unknown", amountMicroUsd: null, checkedAt },
      thresholdMicroUsd: this.sources.getThresholdMicroUsd()
    };
  }
}

/** Every condition key this monitor can raise, so resolved ones can be cleared. */
export const HEALTH_NOTIFICATION_KEYS = [
  "credential:huggingface:missing",
  "credential:huggingface:invalid",
  "credential:vastai:missing",
  "credential:vastai:invalid",
  "balance:below-threshold"
] as const;

/** Maps the snapshot to the bell entries the app should currently show. */
export function deriveHealthNotifications(health: ProviderHealth): NotificationInput[] {
  const entries: NotificationInput[] = [];

  for (const [provider, label, route] of [
    ["huggingface", "Hugging Face", "/settings?section=huggingface"],
    ["vastai", "vast.ai", "/settings?section=vastai"]
  ] as const) {
    const check = health[provider];
    if (check.state === "missing") {
      entries.push({
        key: `credential:${provider}:missing`,
        severity: "warning",
        message: `Add your ${label} API key to download and run models.`,
        action: { label: "Open settings", route },
        dismissible: false
      });
    } else if (check.state === "invalid") {
      entries.push({
        key: `credential:${provider}:invalid`,
        severity: "error",
        message: `Your ${label} API key was rejected. Update it before starting another run.`,
        action: { label: "Open settings", route },
        dismissible: false
      });
    }
  }

  if (health.balance.state === "known" && health.balance.amountMicroUsd < health.thresholdMicroUsd) {
    const remaining = (health.balance.amountMicroUsd / 1_000_000).toFixed(2);
    const threshold = (health.thresholdMicroUsd / 1_000_000).toFixed(2);
    entries.push({
      key: "balance:below-threshold",
      severity: "warning",
      message: `Prepaid GPU balance is $${remaining}, below your $${threshold} warning threshold.`,
      action: { label: "Top up", route: "/settings?section=vastai" }
    });
  }

  return entries;
}
