import type { RuntimeConfig, RuntimeValues } from "@maia/contracts";

export const MIN_CONTEXT_WINDOW = 4096;

/** "up to 131,072, set by the model" / "up to 32,768, a product limit". */
export function describeContextCeiling(config: RuntimeConfig): string {
  const limit = (config.contextWindowMax ?? 32_768).toLocaleString();

  return config.contextWindowMaxSource === "model"
    ? `up to ${limit} tokens, the model's documented maximum`
    : `up to ${limit} tokens, this product's ceiling (the model documents none)`;
}

export function describeCardEstimate(config: RuntimeConfig): string {
  const estimate = config.estimatedMaxContext.toLocaleString();

  return config.fits
    ? `This GPU can hold about ${estimate} tokens at this concurrency.`
    : `This GPU can hold about ${estimate} tokens at this concurrency, so this request may run out of memory.`;
}

/** Null when the values can be submitted; otherwise the sentence to show. */
export function validateRuntimeValues(values: RuntimeValues, config: RuntimeConfig): string | null {
  if (values.contextWindow < MIN_CONTEXT_WINDOW) {
    return `Use at least ${MIN_CONTEXT_WINDOW.toLocaleString()} tokens.`;
  }

  const ceiling = config.contextWindowMax ?? 32_768;
  if (values.contextWindow > ceiling) {
    return `This model allows at most ${ceiling.toLocaleString()} tokens.`;
  }

  if (values.maxConcurrentRequests < 1 || values.maxConcurrentRequests > Math.min(8, config.concurrencyMax)) {
    return `This machine can serve between 1 and ${Math.min(8, config.concurrencyMax)} requests at once at that context.`;
  }

  if (
    values.contextWindow === config.current.contextWindow &&
    values.maxConcurrentRequests === config.current.maxConcurrentRequests
  ) {
    return "Those values are already in force.";
  }

  return null;
}

/**
 * The consequence a person confirms before a restart. It names the billing fact
 * explicitly: nothing new is rented, and the meter keeps running.
 */
export function restartConfirmation(values: RuntimeValues, config: RuntimeConfig): string {
  const context = values.contextWindow.toLocaleString();
  const requests = values.maxConcurrentRequests;
  const risk = config.fits ? "" : "\n\nThis value is above what the GPU can comfortably hold, so the model may fail to start.";

  return [
    `Restart this model with a ${context}-token context window and ${requests} concurrent request${requests === 1 ? "" : "s"}?`,
    "The model is unavailable while it restarts. The GPU stays rented and the meter keeps running.",
    "If this machine cannot restart in place, you will be offered a fresh run with its own estimate before anything is rented."
  ].join("\n\n") + risk;
}

/** Values the panel starts with, once a configuration is available. */
export function initialValues(config: RuntimeConfig): RuntimeValues {
  return { ...config.current };
}
