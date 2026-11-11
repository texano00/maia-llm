import { usagePreferenceSchema, usageSampleSchema } from "../usage-schema.js";
import type { UsageRepository } from "../repositories/usage.js";

/** Errors the route layer maps to HTTP status codes. */
export class UsageError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Accepts one content-free measurement per completed run. The shared Zod schema
 * is strict, so a content-like or unknown key is rejected rather than dropped,
 * and an opted-out installation is refused before anything is stored.
 */
export class UsageService {
  constructor(
    private readonly repository: UsageRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async ingest(payload: unknown, observedAddress: string): Promise<void> {
    const parsed = usageSampleSchema.safeParse(payload);
    if (!parsed.success) {
      throw new UsageError(400, "VALIDATION_FAILED", "The usage sample is invalid.");
    }

    if (await this.repository.isOptedOut(parsed.data.installationId)) {
      throw new UsageError(
        403,
        "USAGE_OPTED_OUT",
        "This installation opted out of usage reporting.",
      );
    }

    await this.repository.append({
      ...parsed.data,
      observedAddress,
      receivedAt: this.now().toISOString(),
    });
  }

  async setPreference(payload: unknown, optedOut: boolean): Promise<void> {
    const parsed = usagePreferenceSchema.safeParse(payload);
    if (!parsed.success) {
      throw new UsageError(400, "VALIDATION_FAILED", "The preference payload is invalid.");
    }

    await this.repository.setOptedOut(
      parsed.data.installationId,
      optedOut,
      this.now().toISOString(),
    );
  }
}
