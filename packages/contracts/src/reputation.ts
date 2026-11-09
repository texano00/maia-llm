import { z } from "zod";
import { DEFAULT_API_BASE_URL } from "./ipc";

/** A machine is either known-good, known-bad, or has no history yet. */
export const gpuStatusSchema = z.enum(["good", "unstable", "unknown"]);

export const gpuOutcomeSchema = z.enum(["success", "failure"]);

export const gpuReputationSchema = z.object({
  /** vast.ai `machine_id`: stable across offers, unlike the offer id. */
  machineId: z.number().int().positive(),
  gpuName: z.string().max(120),
  status: gpuStatusSchema,
  successes: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  lastSuccessAt: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  /** Why the machine was last marked unstable. Never contains prompts or keys. */
  lastError: z.string().max(600).nullable(),
  updatedAt: z.string()
});

export const gpuReportSchema = z.object({
  outcome: gpuOutcomeSchema,
  gpuName: z.string().max(120),
  /** Offer used for the attempt, kept for context only. */
  offerId: z.number().int().positive().optional(),
  error: z.string().max(600).optional()
});

export const gpuListSchema = z.object({
  gpus: z.array(gpuReputationSchema),
  /** Server clock, so clients can reason about staleness without drift. */
  serverTime: z.string()
});

export const gpuUpsertSchema = z.object({
  gpuName: z.string().max(120),
  status: gpuStatusSchema,
  note: z.string().max(600).optional()
});

export type GpuStatus = z.infer<typeof gpuStatusSchema>;
export type GpuOutcome = z.infer<typeof gpuOutcomeSchema>;
export type GpuReputation = z.infer<typeof gpuReputationSchema>;
export type GpuReport = z.infer<typeof gpuReportSchema>;
export type GpuList = z.infer<typeof gpuListSchema>;
export type GpuUpsert = z.infer<typeof gpuUpsertSchema>;

/** Default base URL of the shared service that owns this data. */
export const DEFAULT_REPUTATION_URL = DEFAULT_API_BASE_URL;
