import { z } from "zod";
import { modelCapabilitySchema } from "./domain";

/**
 * One optional, content-free measurement per completed model run. The portal and
 * the desktop share this schema, and `apps/portal/tests/contract/usage-allowlist.test.ts`
 * fails if a content-like key is ever added.
 */
export const usageSampleSchema = z
  .object({
    /** Locally generated pseudonymous identifier; never linked to an account. */
    installationId: z.string().uuid(),
    appVersion: z.string().min(1).max(40),
    os: z.enum(["windows", "linux", "macos"]),
    osVersion: z.string().min(1).max(40),
    arch: z.enum(["x64", "arm64"]),
    deviceClass: z.literal("desktop"),
    modelId: z.string().min(1).max(200),
    capability: modelCapabilitySchema,
    outputTokens: z.number().int().nonnegative().nullable(),
    generationMs: z.number().int().nonnegative().nullable(),
    tokensPerSecond: z.number().positive().nullable(),
    outcome: z.enum(["completed", "failed", "cancelled", "capped", "idle"]),
    occurredAt: z.string()
  })
  .strict();

/** Sent once when a user turns reporting off, so the portal stops accepting. */
export const usagePreferenceSchema = z
  .object({
    installationId: z.string().uuid(),
    occurredAt: z.string()
  })
  .strict();

export type UsageSample = z.infer<typeof usageSampleSchema>;
export type UsagePreference = z.infer<typeof usagePreferenceSchema>;

/** Exact allowlist enforced by the contract test and the portal validator. */
export const USAGE_SAMPLE_KEYS = [
  "installationId",
  "appVersion",
  "os",
  "osVersion",
  "arch",
  "deviceClass",
  "modelId",
  "capability",
  "outputTokens",
  "generationMs",
  "tokensPerSecond",
  "outcome",
  "occurredAt"
] as const;
