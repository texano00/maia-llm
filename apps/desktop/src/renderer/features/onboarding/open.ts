import type { OnboardingStepKey } from "./state";

export const ONBOARDING_EVENT = "maia:onboarding";

/**
 * Opens the guided flow from anywhere that a missing key blocks the user.
 * The overlay listens for this event instead of every screen owning state.
 */
export function openOnboarding(step?: OnboardingStepKey): void {
  window.dispatchEvent(new CustomEvent(ONBOARDING_EVENT, { detail: { step } }));
}
