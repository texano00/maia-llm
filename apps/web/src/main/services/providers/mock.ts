/**
 * Whether this process runs the simulated provider.
 *
 * Opt-in only: the environment must say `mock`. Anything else is live, so a
 * deployment cannot end up simulating rentals by forgetting a variable.
 */
export function isMockProviderMode(): boolean {
  return process.env.MAIA_PROVIDER_MODE?.trim().toLowerCase() === "mock";
}

export function requireMockProviderMode(): void {
  if (!isMockProviderMode()) {
    throw new Error("Mock providers are only available when MAIA_PROVIDER_MODE=mock");
  }
}
