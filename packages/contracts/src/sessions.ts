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

export const sessionEventSchema = z.object({
  at: z.string(),
  level: z.enum(["info", "warn", "error"]),
  message: z.string()
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
  simulated: z.boolean(),
  /** Provisioning / lifecycle log shown in the app, oldest first. */
  events: z.array(sessionEventSchema)
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
  /** Omit to start a new conversation; include to continue an existing one. */
  conversationId: z.string().min(1).optional(),
  content: z.string().min(1).max(32_000)
});

export const chatAbortSchema = z.object({
  sessionId: z.string().min(1)
});
export const chatChunkSchema = z.object({
  sessionId: z.string().min(1),
  conversationId: z.string().min(1),
  /** Reasoning tokens stream before the answer in models that expose them. */
  kind: z.enum(["content", "reasoning"]),
  delta: z.string(),
  done: z.boolean(),
  tokens: z.number().int().nonnegative().optional(),
  errorMessage: z.string().optional()
});

export const gpuFiltersSchema = z.object({
  /** Empty means "any country" — filters are opt-in. */
  countries: z.array(z.string().trim().min(2).max(3)).max(50),
  /** Empty means "any datacenter". */
  datacenters: z.array(z.string().trim().min(1).max(80)).max(50),
  minReliability: z.number().min(0).max(1).nullable(),
  maxHourlyMicroUsd: microUsdSchema.nullable()
});

export const conversationSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  modelId: z.string().nullable(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  /** Pinned conversations sort above the rest. */
  pinned: z.boolean(),
  /** True when no session is running for this conversation's model. */
  frozen: z.boolean()
});

export const conversationMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  createdAt: z.string()
});

export const conversationSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  modelId: z.string().nullable(),
  sessionId: z.string().nullable(),
  updatedAt: z.string()
});

export const conversationDetailSchema = z.object({
  conversation: conversationSchema,
  messages: z.array(conversationMessageSchema),
  frozen: z.boolean()
});

export const sessionEventChannel = "session.event" as const;
export const chatEventChannel = "chat.event" as const;

export type Estimate = z.infer<typeof estimateSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionStart = z.infer<typeof sessionStartSchema>;
export type SessionEnd = z.infer<typeof sessionEndSchema>;
export type ChatSend = z.infer<typeof chatSendSchema>;
export type ChatAbort = z.infer<typeof chatAbortSchema>;
export type ChatChunk = z.infer<typeof chatChunkSchema>;
export type GpuFilters = z.infer<typeof gpuFiltersSchema>;
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationRecord = z.infer<typeof conversationSchema>;
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

export const DEFAULT_GPU_FILTERS: GpuFilters = {
  countries: [],
  datacenters: [],
  minReliability: null,
  maxHourlyMicroUsd: null
};
