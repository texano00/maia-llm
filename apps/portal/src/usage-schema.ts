import { z } from "zod";

/**
 * Server-side mirror of `packages/contracts/src/usage.ts`. The portal compiles
 * with its own `rootDir`, so it cannot import the workspace package at build
 * time; `apps/portal/tests/contract/usage-allowlist.test.ts` keeps the two key
 * sets identical.
 */
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
  "occurredAt",
] as const;

export const usageSampleSchema = z
  .object({
    installationId: z.string().uuid(),
    appVersion: z.string().min(1).max(40),
    os: z.enum(["windows", "linux", "macos"]),
    osVersion: z.string().min(1).max(40),
    arch: z.enum(["x64", "arm64"]),
    deviceClass: z.literal("desktop"),
    modelId: z.string().min(1).max(200),
    capability: z.enum(["text", "text-to-image", "image-to-text", "image-to-image"]),
    outputTokens: z.number().int().nonnegative().nullable(),
    generationMs: z.number().int().nonnegative().nullable(),
    tokensPerSecond: z.number().positive().nullable(),
    outcome: z.enum(["completed", "failed", "cancelled", "capped", "idle"]),
    occurredAt: z.string(),
  })
  .strict();

export const usagePreferenceSchema = z
  .object({
    installationId: z.string().uuid(),
    occurredAt: z.string(),
  })
  .strict();

export type UsageSample = z.infer<typeof usageSampleSchema>;
export type UsagePreference = z.infer<typeof usagePreferenceSchema>;
