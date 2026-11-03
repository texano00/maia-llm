export function isMockProviderMode(): boolean {
  return process.env.MAIA_PROVIDER_MODE === "mock";
}

export function requireMockProviderMode(): void {
  if (!isMockProviderMode()) {
    throw new Error("Mock providers are only available when MAIA_PROVIDER_MODE=mock");
  }
}
