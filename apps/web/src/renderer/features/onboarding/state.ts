import type { AppSettings, CredentialStatus } from "@maia/contracts";

export type OnboardingStepKey = "huggingface" | "vastai" | "finish";

export const ONBOARDING_STEPS: ReadonlyArray<{ key: OnboardingStepKey; title: string }> = [
  { key: "huggingface", title: "Hugging Face token" },
  { key: "vastai", title: "vast.ai API key" },
  { key: "finish", title: "You are ready" }
];

/** The first key the user still needs, or `finish` when both are present. */
export function firstIncompleteStep(status: CredentialStatus): OnboardingStepKey {
  if (!status.huggingface) {
    return "huggingface";
  }
  if (!status.vastai) {
    return "vastai";
  }

  return "finish";
}

/**
 * The guided flow appears once. Completion or dismissal is sticky, and it never
 * steals the screen once both keys exist.
 */
export function shouldShowOnboarding(settings: AppSettings, status: CredentialStatus): boolean {
  if (settings.onboardingCompleted || settings.onboardingDismissedAt !== null) {
    return false;
  }

  return firstIncompleteStep(status) !== "finish";
}
