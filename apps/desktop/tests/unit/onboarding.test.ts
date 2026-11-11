import { describe, expect, it } from "vitest";
import type { AppSettings, CredentialStatus } from "@maia/contracts";
import {
  firstIncompleteStep,
  shouldShowOnboarding
} from "../../src/renderer/features/onboarding/state";

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
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
    usageReporting: false,
    walletWarnThresholdMicroUsd: 2_000_000,
    onboardingCompleted: false,
    onboardingDismissedAt: null,
    dismissedNotificationKeys: [],
    installationId: null,
    ...overrides
  };
}

function credentials(huggingface: boolean, vastai: boolean): CredentialStatus {
  return { huggingface, vastai, s3: false };
}

describe("onboarding gate", () => {
  it("shows on a clean install and starts at the missing key", () => {
    expect(shouldShowOnboarding(settings(), credentials(false, false))).toBe(true);
    expect(firstIncompleteStep(credentials(false, false))).toBe("huggingface");
    expect(firstIncompleteStep(credentials(true, false))).toBe("vastai");
    expect(firstIncompleteStep(credentials(true, true))).toBe("finish");
  });

  it("disappears once both keys exist", () => {
    expect(shouldShowOnboarding(settings(), credentials(true, true))).toBe(false);
  });

  it("never interrupts again after completion or dismissal", () => {
    expect(shouldShowOnboarding(settings({ onboardingCompleted: true }), credentials(false, false))).toBe(
      false
    );
    expect(
      shouldShowOnboarding(
        settings({ onboardingDismissedAt: "2026-11-11T10:00:00.000Z" }),
        credentials(false, false)
      )
    ).toBe(false);
  });
});
