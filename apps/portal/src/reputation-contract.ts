import { z } from "zod";

/**
 * The telemetry API is a standalone service: like `diagnostics.ts` it keeps its
 * own copies of the wire schemas instead of importing the desktop contracts
 * package (different module resolution and deployment lifecycle).
 * Keep in sync with `packages/contracts/src/reputation.ts`.
 */
export const gpuStatusSchema = z.enum(["good", "unstable", "unknown"]);

export const gpuOutcomeSchema = z.enum(["success", "failure"]);

export const gpuReputationSchema = z.object({
  machineId: z.number().int().positive(),
  gpuName: z.string().max(120),
  status: gpuStatusSchema,
  successes: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  lastSuccessAt: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  lastError: z.string().max(600).nullable(),
  updatedAt: z.string(),
});

export const gpuReportSchema = z.object({
  outcome: gpuOutcomeSchema,
  gpuName: z.string().max(120),
  offerId: z.number().int().positive().optional(),
  error: z.string().max(600).optional(),
});

export const gpuListSchema = z.object({
  gpus: z.array(gpuReputationSchema),
  serverTime: z.string(),
});

export const gpuUpsertSchema = z.object({
  gpuName: z.string().max(120),
  status: gpuStatusSchema,
  note: z.string().max(600).optional(),
});

export type GpuStatus = z.infer<typeof gpuStatusSchema>;
export type GpuOutcome = z.infer<typeof gpuOutcomeSchema>;
export type GpuReputation = z.infer<typeof gpuReputationSchema>;
export type GpuReport = z.infer<typeof gpuReportSchema>;
export type GpuUpsert = z.infer<typeof gpuUpsertSchema>;
