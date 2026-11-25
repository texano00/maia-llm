import { z } from "zod";
import {
  inferenceRuntimeSchema,
  modelCapabilitySchema,
  powerTierSchema,
  releaseReasonSchema,
  sessionStateSchema
} from "./domain";

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
  /** Compute power tier the estimate was priced for. */
  powerTier: powerTierSchema.default("balanced"),
  /** Demo/offline runs still show a price so the flow can be exercised. */
  simulated: z.boolean()
});

export const sessionEventSchema = z.object({
  at: z.string(),
  level: z.enum(["info", "warn", "error"]),
  message: z.string()
});

/**
 * What a booting run is doing, in plain words, plus when we last saw it move.
 * A phase older than a minute is never presented as current.
 */
export const bootPhaseSchema = z.object({
  text: z.string().min(1).max(200),
  percent: z.number().int().min(0).max(100).nullable(),
  observedAt: z.string(),
  source: z.enum(["container", "provider", "app"])
});

/** Where the model server answers, once the host has published a port. */
export const sessionBootEndpointSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  /** True only after an inference request has been answered (FR-001). */
  serving: z.boolean()
});

/** Why a run was released, and how far it got. */
export const sessionReleaseSchema = z.object({
  reason: releaseReasonSchema,
  phase: z.string().max(200).nullable(),
  elapsedMs: z.number().int().nonnegative()
});

/**
 * The values a person can change on a run. Both take effect only when the
 * model server starts, so a change is applied through a restart.
 */
export const runtimeValuesSchema = z.object({
  /** Per-request context window, in tokens. */
  contextWindow: z.number().int().min(4096),
  /** Requests the server handles at once. */
  maxConcurrentRequests: z.number().int().min(1).max(8)
});

export const restartStateSchema = z.object({
  startedAt: z.string(),
  previous: runtimeValuesSchema,
  target: runtimeValuesSchema,
  phase: z.enum(["stopping", "booting", "serving"])
});

export const runtimeConfigSchema = z.object({
  current: runtimeValuesSchema,
  defaults: runtimeValuesSchema,
  /** Largest context the model itself documents; null when it documents none. */
  contextWindowMax: z.number().int().positive().nullable(),
  /** "model" when the maximum above came from the model, "product" otherwise. */
  contextWindowMaxSource: z.enum(["model", "product"]),
  /** Requests range this card can serve at the current context. */
  concurrencyMax: z.number().int().min(1),
  /** What the card can plausibly hold at this concurrency (advisory). */
  estimatedMaxContext: z.number().int().positive(),
  /** True when `current` is at or below the advisory estimate. */
  fits: z.boolean(),
  /** Non-null while a restart is in flight. */
  restart: restartStateSchema.nullable()
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
  /** Compute power tier the run was started with. */
  powerTier: powerTierSchema.default("balanced"),
  /** What the run can serve; text-only runs keep the historical default. */
  capability: modelCapabilitySchema.default("text"),
  simulated: z.boolean(),
  /** Provisioning / lifecycle log shown in the app, oldest first. */
  events: z.array(sessionEventSchema),
  /** Current boot phase while starting; null once the run is active or ended. */
  boot: bootPhaseSchema.nullable().default(null),
  /** Mapped address, present from the moment the provider publishes a port. */
  endpoint: sessionBootEndpointSchema.nullable().default(null),
  /** Set on every terminal path (FR-007). Absent on runs from before 0.12.0. */
  release: sessionReleaseSchema.nullable().default(null),
  /** The values this run was launched with and the ceilings they were checked against. */
  runtimeConfig: runtimeConfigSchema.nullable().default(null),
  /** Present only while a restart is in flight. */
  restart: restartStateSchema.nullable().default(null)
});

export const restartResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("restarted"),
    session: sessionSchema,
    config: runtimeConfigSchema
  }),
  z.object({
    status: z.literal("failed"),
    session: sessionSchema,
    config: runtimeConfigSchema,
    reason: z.string().min(1)
  }),
  z.object({
    status: z.literal("fresh_run_required"),
    session: sessionSchema,
    estimate: estimateSchema,
    reason: z.string().min(1)
  })
]);

export const restartRequestSchema = z.object({
  sessionId: z.string().min(1).max(100),
  /** Mirrors `confirmEstimate`: the person has seen the consequences. */
  confirmRestart: z.literal(true),
  values: runtimeValuesSchema
});

export const sessionStartSchema = z.object({
  estimateId: z.string().min(1),
  /** Provisioning is refused unless the caller confirms the shown estimate. */
  confirmEstimate: z.literal(true),
  /** Compute power tier the user confirmed in the catalogue popup. */
  powerTier: powerTierSchema.optional(),
  /** Gated models require explicit confirmation before Maia provisions a GPU. */
  confirmGatedAccess: z.boolean().optional()
});

export const sessionEndSchema = z.object({
  sessionId: z.string().min(1),
  reason: z.enum(["user", "idle", "cap", "app_exit", "failure"]).optional()
});

/**
 * Vision input limits. Four images per turn is what the usual chat UIs allow
 * and keeps one request under the 20 MB the model server accepts without
 * chunking the upload.
 */
export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const imageMimeTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);

export const IMAGE_MIME_TYPES = imageMimeTypeSchema.options;

/** An image on its way to the model: base64 without the `data:` prefix. */
export const chatImageInputSchema = z.object({
  mimeType: imageMimeTypeSchema,
  dataBase64: z.string().min(1)
});

/** An image already saved next to the conversation; payloads load on demand. */
export const chatImageSchema = z.object({
  id: z.string().min(1),
  mimeType: imageMimeTypeSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive()
});

export const chatSendSchema = z.object({
  sessionId: z.string().min(1),
  /** Omit to start a new conversation; include to continue an existing one. */
  conversationId: z.string().min(1).optional(),
  content: z.string().min(1).max(32_000),
  /**
   * Images for a vision run. The main process saves them before inference, so
   * the transcript keeps them after the session is released.
   */
  images: z.array(chatImageInputSchema).max(MAX_IMAGES_PER_MESSAGE).default([])
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
  errorMessage: z.string().optional(),
  /** Messages the model did not see because they did not fit its context. */
  omittedMessages: z.number().int().nonnegative().optional(),
  /** True while the run is restarting; the composer is unavailable. */
  restarting: z.boolean().optional()
});

/** What a turn produced, including what the model was not shown. */
export const chatTurnResultSchema = z.object({
  conversationId: z.string().min(1),
  tokens: z.number().int().nonnegative(),
  text: z.string(),
  /** Count of stored messages excluded from the model's view. */
  omittedMessages: z.number().int().nonnegative()
});

export const chatRegenerateSchema = z.object({
  sessionId: z.string().min(1).max(100),
  conversationId: z.string().min(1).max(100),
  assistantMessageId: z.string().min(1).max(100)
});

export const chatEditSchema = z.object({
  sessionId: z.string().min(1).max(100),
  conversationId: z.string().min(1).max(100),
  userMessageId: z.string().min(1).max(100),
  content: z.string().min(1).max(32_000)
});

/**
 * Startup gates. A cold start transfers ~25 GB (9.7 GB image + model weights)
 * before vLLM can answer, so a host slower than these figures turns a two-minute
 * boot into a ten-minute one. Measured on vast.ai: hosts below 1 Gbps downlink
 * are ~3x slower to first token.
 */
export const DEFAULT_MIN_DOWNLOAD_MBPS = 1000;
export const DEFAULT_MIN_UPLOAD_MBPS = 200;
export const DEFAULT_MIN_DISK_BANDWIDTH_MBPS = 500;

export const gpuFiltersSchema = z.object({
  /** Empty means "any country" — filters are opt-in. */
  countries: z.array(z.string().trim().min(2).max(3)).max(50),
  /** Empty means "any datacenter". */
  datacenters: z.array(z.string().trim().min(1).max(80)).max(50),
  minReliability: z.number().min(0).max(1).nullable(),
  maxHourlyMicroUsd: microUsdSchema.nullable(),
  /** Host downlink in Mbps; null disables the gate. */
  minDownloadMbps: z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .nullable()
    .default(DEFAULT_MIN_DOWNLOAD_MBPS),
  /** Host uplink in Mbps; null disables the gate. */
  minUploadMbps: z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .nullable()
    .default(DEFAULT_MIN_UPLOAD_MBPS),
  /** Local disk bandwidth in MB/s; null disables the gate. */
  minDiskBandwidthMBps: z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .nullable()
    .default(DEFAULT_MIN_DISK_BANDWIDTH_MBPS)
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
  /** Reasoning tokens the model streamed before the answer, when it exposed any. */
  reasoning: z.string().nullable(),
  /** Images attached to this turn, loaded separately so a transcript stays light. */
  images: z.array(chatImageSchema).default([]),
  /** True when the person stopped the reply or it failed before finishing. */
  interrupted: z.boolean().default(false),
  /** Plain-language failure for an interrupted turn, when one was recorded. */
  errorCode: z.string().nullable().default(null),
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

/**
 * How an external tool reaches a running model. The key belongs to one run, is
 * generated on the device, and is shown only while that run serves.
 */
export const sessionEndpointSchema = z.object({
  /** OpenAI-compatible base URL, including host, port and `/v1`. */
  baseUrl: z.string().min(1),
  /** Model identifier to send in requests. */
  modelId: z.string().min(1),
  /** Bearer key the server requires. */
  apiKey: z.string().min(1),
  /** Always true: the channel answers null for a run that is not serving. */
  serving: z.literal(true)
});

export type SessionEndpoint = z.infer<typeof sessionEndpointSchema>;

/** What the catalogue power popup shows before an estimate exists. */
export const estimatePreviewResultSchema = z.object({
  modelId: z.string().min(1),
  powerTier: powerTierSchema,
  hourlyRateMicroUsd: microUsdSchema,
  projectedTotalMicroUsd: microUsdSchema,
  projectedTokensPerSecond: z.number().positive(),
  projectionSource: z.enum(["measured", "default"]),
  sampleCount: z.number().int().nonnegative(),
  simulated: z.boolean()
});

export type EstimatePreview = z.infer<typeof estimatePreviewResultSchema>;

export type Estimate = z.infer<typeof estimateSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type RuntimeValues = z.infer<typeof runtimeValuesSchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type RestartState = z.infer<typeof restartStateSchema>;
export type RestartRequest = z.infer<typeof restartRequestSchema>;
export type RestartResult = z.infer<typeof restartResultSchema>;
export type ChatTurnResult = z.infer<typeof chatTurnResultSchema>;
export type ChatRegenerate = z.infer<typeof chatRegenerateSchema>;
export type ChatEdit = z.infer<typeof chatEditSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionStart = z.infer<typeof sessionStartSchema>;
export type SessionEnd = z.infer<typeof sessionEndSchema>;
export type ChatSend = z.infer<typeof chatSendSchema>;
export type ChatAbort = z.infer<typeof chatAbortSchema>;
export type ChatChunk = z.infer<typeof chatChunkSchema>;
export type GpuFilters = z.infer<typeof gpuFiltersSchema>;
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ChatImage = z.infer<typeof chatImageSchema>;
export type ChatImageInput = z.infer<typeof chatImageInputSchema>;
export type ConversationRecord = z.infer<typeof conversationSchema>;
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

export const DEFAULT_GPU_FILTERS: GpuFilters = {
  countries: [],
  datacenters: [],
  minReliability: null,
  maxHourlyMicroUsd: null,
  minDownloadMbps: DEFAULT_MIN_DOWNLOAD_MBPS,
  minUploadMbps: DEFAULT_MIN_UPLOAD_MBPS,
  minDiskBandwidthMBps: DEFAULT_MIN_DISK_BANDWIDTH_MBPS
};
