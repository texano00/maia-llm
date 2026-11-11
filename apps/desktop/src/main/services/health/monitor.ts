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
  now?: () => Date;
}

/**
 * Provider readiness snapshot used by the header bell and the balance badge.
 * Checks never throw: an unreachable provider is reported as `unknown`, and an
 * unreadable balance is never rendered as zero.
 */
export class ProviderHealthMonitor {
  private readonly now: () => Date;
  private value: ProviderHealth;

  constructor(private readonly sources: ProviderHealthSources) {
    this.now = sources.now ?? (() => new Date());
    this.value = this.unknownSnapshot();
  }

  current(): ProviderHealth {
    return this.value;
  }

  async refresh(): Promise<ProviderHealth> {
    const checkedAt = this.now().toISOString();
    const [huggingface, vastai, balance] = await Promise.all([
      this.checkCredential(this.sources.hasHuggingFace, this.sources.verifyHuggingFace, checkedAt),
      this.checkCredential(this.sources.hasVastai, this.sources.verifyVastai, checkedAt),
      this.readBalance(checkedAt)
    ]);

    this.value = {
      huggingface,
      vastai,
      balance,
      thresholdMicroUsd: this.sources.getThresholdMicroUsd()
    };

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

/** Maps the snapshot to the bell entries the app should currently show. */
export function deriveHealthNotifications(health: ProviderHealth): NotificationInput[] {
  const entries: NotificationInput[] = [];

  for (const [provider, label, route] of [
    ["huggingface", "Hugging Face", "/settings"],
    ["vastai", "vast.ai", "/settings"]
  ] as const) {
    const check = health[provider];
    if (check.state === "missing") {
      entries.push({
        key: `credential:${provider}:missing`,
        severity: "warning",
        message: `Add your ${label} API key to download and run models.`,
        action: { label: "Open settings", route }
      });
    } else if (check.state === "invalid") {
      entries.push({
        key: `credential:${provider}:invalid`,
        severity: "error",
        message: `Your ${label} API key was rejected. Update it before starting another run.`,
        action: { label: "Open settings", route }
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
      action: { label: "Top up", route: "/settings" }
    });
  }

  return entries;
}
