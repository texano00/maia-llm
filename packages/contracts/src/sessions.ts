import { z } from "zod";
import { inferenceRuntimeSchema, sessionStateSchema } from "./domain";

export const CURRENCY = "USD" as const;

/** Money is always integer micro-USD so rounding never loses cents. */
export const microUsdSchema = z.number().int().nonnegative();

export const estimateSchema = z.object({
  id: z.string().min(1),
  modelId: z.string().min(1),
  createdAt: z.string(),
  gpuName: z.string().min(1),
  gpuRamGb: z.number().int().positive(),
  /** Hourly rate of the selected offer. */
  hourlyRateMicroUsd: microUsdSchema,
  minimumMinutes: z.number().int().positive(),
  expectedMinutes: z.number().int().positive(),
  projectedTotalMicroUsd: microUsdSchema,
  /** Optimistic and pessimistic bounds for the expected session length. */
  rangeMicroUsd: z.object({ low: microUsdSchema, high: microUsdSchema }),
  /** Provisioning wait estimate, ±50% as required by FR-009. */
  waitMinutes: z.object({ low: z.number().nonnegative(), high: z.number().nonnegative() }),
  currency: z.literal(CURRENCY),
  assumptions: z.array(z.string()),
  notes: z.array(z.string()),
  /** Demo/offline runs still show a price so the flow can be exercised. */
  simulated: z.boolean()
});

export const sessionSchema = z.object({
  id: z.string().min(1),
  modelId: z.string().min(1),
  state: sessionStateSchema,
  runtime: inferenceRuntimeSchema,
  label: z.string().min(1),
  gpuName: z.string().nullable(),
  gpuRamGb: z.number().int().positive().nullable(),
  hourlyRateMicroUsd: microUsdSchema,
  estimatedTotalMicroUsd: microUsdSchema,
  startedAt: z.string(),
  readyAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  endReason: z
    .enum(["user", "idle", "cap", "app_exit", "failure", "reconciled"])
    .nullable(),
  instanceId: z.number().int().positive().nullable(),
  simulated: z.boolean()
});

export const sessionStartSchema = z.object({
  estimateId: z.string().min(1),
  /** Provisioning is refused unless the caller confirms the shown estimate. */
  confirmEstimate: z.literal(true),
  generation: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(1).max(8192).optional(),
      contextWindow: z.number().int().min(512).max(262144).optional()
    })
    .optional()
});

export const sessionEndSchema = z.object({
  sessionId: z.string().min(1),
  reason: z.enum(["user", "idle", "cap", "app_exit", "failure"]).optional()
});

export const chatSendSchema = z.object({
  sessionId: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  content: z.string().min(1).max(32_000)
});

export const chatAbortSchema = z.object({
  sessionId: z.string().min(1)
});

export const chatChunkSchema = z.object({
  sessionId: z.string().min(1),
  delta: z.string(),
  done: z.boolean(),
  tokens: z.number().int().nonnegative().optional(),
  errorMessage: z.string().optional()
});

export const sessionEventChannel = "session.event" as const;
export const chatEventChannel = "chat.event" as const;

export type Estimate = z.infer<typeof estimateSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type SessionStart = z.infer<typeof sessionStartSchema>;
export type SessionEnd = z.infer<typeof sessionEndSchema>;
export type ChatSend = z.infer<typeof chatSendSchema>;
export type ChatAbort = z.infer<typeof chatAbortSchema>;
export type ChatChunk = z.infer<typeof chatChunkSchema>;
