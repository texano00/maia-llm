import { describe, expect, it } from "vitest";
import type { AppSettings, Session } from "@maia/contracts";
import { USAGE_SAMPLE_KEYS } from "@maia/contracts";
import { buildUsageSample, UsageReporter } from "../../src/main/services/telemetry/usage";
import type { InstallationFacts } from "../../src/main/services/telemetry/identity";

const FACTS: InstallationFacts = {
  installationId: "33333333-3333-4333-8333-333333333333",
  appVersion: "0.8.4",
  os: "windows",
  osVersion: "11",
  arch: "x64",
  deviceClass: "desktop"
};

const SESSION: Session = {
  id: "session-1",
  modelId: "Qwen/Qwen2.5-7B-Instruct",
  state: "ended",
  runtime: "vllm",
  label: "run",
  gpuName: "RTX 4090",
  gpuRamGb: 24,
  hourlyRateMicroUsd: 440_000,
  estimatedTotalMicroUsd: 220_000,
  startedAt: "2026-11-11T10:00:00.000Z",
  readyAt: "2026-11-11T10:01:00.000Z",
  endedAt: "2026-11-11T10:30:00.000Z",
  endReason: "user",
  instanceId: 42,
  powerTier: "balanced",
  capability: "text",
  simulated: false,
  events: []
};

const METRIC = {
  outputTokens: 400,
  generationMs: 8_000,
  tokensPerSecond: 50,
  outcome: "cancelled" as const
};

function settings(usageReporting: boolean): AppSettings {
  return {
    diagnosticsUrl: "https://api.maiallm.com",
    gpuFilters: {
      countries: [],
      datacenters: [],
      minReliability: null,
      maxHourlyMicroUsd: null,
      minDownloadMbps: 1000,
      minUploadMbps: 200,
      minDiskBandwidthMBps: 500
    },
    gpuStartupRetries: 5,
    ideEndpointEnabled: false,
    ideEndpointPort: 11434,
    usageReporting,
    walletWarnThresholdMicroUsd: 2_000_000,
    onboardingCompleted: true,
    onboardingDismissedAt: null,
    dismissedNotificationKeys: [],
    installationId: FACTS.installationId
  };
}

function reporter(usageReporting: boolean) {
  const posted: Array<{ path: string; body: unknown }> = [];
  const subject = new UsageReporter({
    settings: () => settings(usageReporting),
    facts: () => FACTS,
    post: async (path, body) => {
      posted.push({ path, body });
      return true;
    },
    now: () => new Date("2026-11-11T11:00:00.000Z")
  });

  return { subject, posted };
}

describe("usage reporting", () => {
  it("sends nothing while reporting is off", async () => {
    const { subject, posted } = reporter(false);

    expect(await subject.report(SESSION, METRIC)).toBe(false);
    expect(posted).toEqual([]);
  });

  it("sends exactly one allowlisted sample per run when on", async () => {
    const { subject, posted } = reporter(true);

    expect(await subject.report(SESSION, METRIC)).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.path).toBe("/api/v0/usage");

    const body = posted[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([...USAGE_SAMPLE_KEYS].sort());
    expect(body).toMatchObject({
      installationId: FACTS.installationId,
      modelId: SESSION.modelId,
      capability: "text",
      tokensPerSecond: 50,
      outcome: "cancelled"
    });
    for (const forbidden of ["prompt", "response", "content", "path", "image"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it("signals the preference so the portal can stop accepting samples", async () => {
    const { subject, posted } = reporter(true);

    await subject.preference(false);
    await subject.preference(true);

    expect(posted.map((entry) => entry.path)).toEqual([
      "/api/v0/usage/opt-out",
      "/api/v0/usage/opt-in"
    ]);
  });

  it("builds samples with the tier-independent allowlisted shape", () => {
    const sample = buildUsageSample(FACTS, SESSION, METRIC, "2026-11-11T11:00:00.000Z");

    expect(Object.keys(sample).sort()).toEqual([...USAGE_SAMPLE_KEYS].sort());
    expect(sample.deviceClass).toBe("desktop");
  });
});
