import { describe, expect, it } from "vitest";
import {
  deriveHealthNotifications,
  ProviderHealthMonitor
} from "../../src/main/services/health/monitor";

const now = () => new Date("2026-11-11T10:00:00.000Z");

function monitor(overrides: {
  hasHuggingFace?: () => Promise<boolean>;
  verifyHuggingFace?: () => Promise<boolean>;
  hasVastai?: () => Promise<boolean>;
  verifyVastai?: () => Promise<boolean>;
  balance?: number | null;
  threshold?: number;
}) {
  return new ProviderHealthMonitor({
    hasHuggingFace: overrides.hasHuggingFace ?? (async () => true),
    verifyHuggingFace: overrides.verifyHuggingFace,
    hasVastai: overrides.hasVastai ?? (async () => true),
    verifyVastai: overrides.verifyVastai,
    getBalanceMicroUsd: async () =>
      overrides.balance === undefined ? 10_000_000 : overrides.balance,
    getThresholdMicroUsd: () => overrides.threshold ?? 2_000_000,
    now
  });
}

describe("ProviderHealthMonitor", () => {
  it("reports missing keys before verification", async () => {
    const snapshot = await monitor({
      hasHuggingFace: async () => false,
      verifyVastai: async () => true
    }).refresh();

    expect(snapshot.huggingface.state).toBe("missing");
    expect(snapshot.vastai.state).toBe("ok");
  });

  it("reports rejected keys and keeps working keys", async () => {
    const snapshot = await monitor({ verifyVastai: async () => false, verifyHuggingFace: async () => true }).refresh();

    expect(snapshot.vastai.state).toBe("invalid");
    expect(snapshot.huggingface.state).toBe("ok");
  });

  it("treats an unreachable provider as unknown rather than missing", async () => {
    const snapshot = await monitor({
      verifyHuggingFace: async () => {
        throw new Error("offline");
      }
    }).refresh();

    expect(snapshot.huggingface.state).toBe("unknown");
  });

  it("never reports an unreadable balance as zero", async () => {
    const snapshot = await monitor({ balance: null }).refresh();

    expect(snapshot.balance).toMatchObject({ state: "unknown", amountMicroUsd: null });
  });

  it("warns only when the balance is below the threshold", async () => {
    const below = deriveHealthNotifications(await monitor({ balance: 1_500_000 }).refresh());
    const above = deriveHealthNotifications(await monitor({ balance: 5_000_000 }).refresh());

    expect(below.map((entry) => entry.key)).toContain("balance:below-threshold");
    expect(above.map((entry) => entry.key)).not.toContain("balance:below-threshold");
  });

  it("derives a warning for a missing key and an error for a rejected one", () => {
    const missing = deriveHealthNotifications({
      huggingface: { state: "missing", checkedAt: "2026-11-11T10:00:00.000Z" },
      vastai: { state: "ok", checkedAt: "2026-11-11T10:00:00.000Z" },
      balance: { state: "known", amountMicroUsd: 5_000_000, checkedAt: "2026-11-11T10:00:00.000Z" },
      thresholdMicroUsd: 2_000_000
    });
    const rejected = deriveHealthNotifications({
      huggingface: { state: "invalid", checkedAt: "2026-11-11T10:00:00.000Z" },
      vastai: { state: "ok", checkedAt: "2026-11-11T10:00:00.000Z" },
      balance: { state: "unknown", amountMicroUsd: null, checkedAt: "2026-11-11T10:00:00.000Z" },
      thresholdMicroUsd: 2_000_000
    });

    expect(missing[0]).toMatchObject({ severity: "warning", key: "credential:huggingface:missing" });
    expect(rejected[0]).toMatchObject({ severity: "error", key: "credential:huggingface:invalid" });
  });
});
