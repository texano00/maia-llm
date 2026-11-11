import { z } from "zod";
import { powerTierSchema, releaseChannelSchema } from "./domain";
import { gpuFiltersSchema, microUsdSchema } from "./sessions";

export const errorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "NOT_AUTHENTICATED",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "NO_OFFER",
  "SESSION_CONFLICT",
  "MODEL_NOT_READY",
  "BUDGET_EXCEEDED",
  "PORT_CONFLICT",
  "STORAGE_AUTH_FAILED",
  "BACKUP_VERIFY_FAILED",
  "TELEMETRY_DISABLED",
  "NOT_FOUND",
  "ESTIMATE_REQUIRED",
  "GATED_ACCESS_REQUIRED",
  "CAPABILITY_UNSUPPORTED",
  "USAGE_OPTED_OUT",
  "INTERNAL"
]);

export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional()
});

export const appInfoSchema = z.object({
  app: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  channel: releaseChannelSchema,
  packaged: z.boolean()
});

/**
 * Lifecycle of an in-app update. The renderer only depends on this enum, so the
 * main process can swap the transport (electron-updater, a manifest feed, or a
 * simulated update in development) without touching the UI.
 */
export const updatePhaseSchema = z.enum([
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "ready",
  "installing",
  "error"
]);

export const updateStatusSchema = z.object({
  phase: updatePhaseSchema,
  currentVersion: z.string(),
  channel: releaseChannelSchema,
  /** False when the running build cannot self-update (for example a dev run). */
  supported: z.boolean(),
  latestVersion: z.string().optional(),
  releaseNotes: z.string().optional(),
  releaseDate: z.string().optional(),
  progressPercent: z.number().min(0).max(100).optional(),
  bytesPerSecond: z.number().nonnegative().optional(),
  errorMessage: z.string().optional(),
  checkedAt: z.string().optional()
});

export const ipcChannels = [
  "app.info",
  "settings.get",
  "settings.update",
  "settings.credentials.status",
  "settings.credentials.set",
  "settings.credentials.test",
  "settings.credentials.clear",
  "catalogue.search",
  "catalogue.detail",
  "catalogue.refresh",
  "catalogue.useCases",
  "estimate.create",
  "estimate.preview",
  "session.list",
  /** Locally persisted sessions in a terminal/teardown state (Models view). */
  "session.history",
  "session.status",
  "session.start",
  "session.end",
  /** Base URL, model id and per-run key for using a running model elsewhere. */
  "session.endpoint",
  "conversation.list",
  "conversation.get",
  "conversation.rename",
  "conversation.setPinned",
  "conversation.switchModel",
  "conversation.delete",
  /** Loads one saved image as a data URL for the transcript. */
  "conversation.image",
  "chat.send",
  "chat.abort",
  "notifications.list",
  "notifications.dismiss",
  "provider.health",
  "update.status",
  "update.check",
  "update.download",
  "update.install"
] as const;

/** Main -> renderer push channel used for update status changes. */
export const updateEventChannel = "update.event" as const;

/** Main -> renderer push when a readiness notification is activated. */
export const readyEventChannel = "session.ready.event" as const;

export const readyEventSchema = z.object({
  sessionId: z.string().min(1)
});
export type ReadyEvent = z.infer<typeof readyEventSchema>;

/**
 * The published backend. Catalogue, telemetry and GPU reputation all live on it,
 * so one constant keeps the desktop pointed at the same place.
 */
export const DEFAULT_API_BASE_URL = "https://api.maiallm.com";

export const DEFAULT_DIAGNOSTICS_URL = DEFAULT_API_BASE_URL;
export const DEFAULT_GPU_STARTUP_RETRIES = 5;

const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => /^https?:\/\/[^\s]+$/i.test(value), {
    message: "Enter an http:// or https:// URL"
  });

/**
 * User-editable application settings. Diagnostics mirror the local log file to
 * the telemetry host so a packaged build can be observed while it runs.
 */
export const appSettingsSchema = z.object({
  diagnosticsUrl: httpUrlSchema,
  /** Optional GPU preferences used when ranking offers; empty means no filter. */
  gpuFilters: gpuFiltersSchema,
  /**
   * Extra GPU machines to try when a boot fails (the container will not start,
   * the host never reports in, the port never opens…). One more attempt follows
   * the first one, so the total is this value + 1.
   */
  gpuStartupRetries: z.number().int().min(0).max(10).default(DEFAULT_GPU_STARTUP_RETRIES),
  /**
   * Opt-in, content-free usage measurements (tokens per second per run). Off by
   * default: nothing leaves the machine until the user enables it.
   */
  usageReporting: z.boolean().default(false),
  /** Warn when the prepaid GPU balance falls below this amount. */
  walletWarnThresholdMicroUsd: z.number().int().positive().default(2_000_000),
  /** Set once both provider keys have been verified in the guided flow. */
  onboardingCompleted: z.boolean().default(false),
  /** Set when the guided flow is dismissed; it does not interrupt again. */
  onboardingDismissedAt: z.string().nullable().default(null),
  /** Notification condition keys the user has acknowledged. */
  dismissedNotificationKeys: z.array(z.string().min(1)).max(100).default([]),
  /** Pseudonymous identifier used only for opt-in usage samples. */
  installationId: z.string().uuid().nullable().default(null)
});

export const settingsUpdateSchema = appSettingsSchema.partial();

const credentialSecretSchema = z.string().min(1).max(4_000);

export const credentialProviderSchema = z.enum(["huggingface", "vastai", "s3"]);

export const setCredentialSchema = z.object({
  provider: credentialProviderSchema,
  secret: credentialSecretSchema
});

export const testCredentialSchema = z.object({
  provider: credentialProviderSchema
});

export const clearCredentialSchema = z.object({
  provider: credentialProviderSchema
});

export const credentialStatusSchema = z.object({
  huggingface: z.boolean(),
  vastai: z.boolean(),
  s3: z.boolean()
});

export const credentialTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string()
});

export const notificationDismissSchema = z.object({
  key: z.string().trim().min(1).max(120)
});

export const conversationDeleteSchema = z.object({
  id: z.string().min(1).max(100)
});

export const conversationImageRequestSchema = z.object({
  id: z.string().min(1).max(100)
});

export const conversationImageResultSchema = z.object({
  id: z.string().min(1),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  dataBase64: z.string().min(1)
});

export type ConversationImageRequest = z.infer<typeof conversationImageRequestSchema>;
export type ConversationImageResult = z.infer<typeof conversationImageResultSchema>;

export const estimatePreviewSchema = z.object({
  modelId: z.string().min(1).max(200),
  powerTier: powerTierSchema
});

export const notificationSchema = z.object({
  key: z.string().min(1),
  severity: z.enum(["warning", "error"]),
  message: z.string().min(1),
  action: z
    .object({ label: z.string().min(1), route: z.string().min(1) })
    .optional(),
  createdAt: z.string()
});

export const notificationSnapshotSchema = z.object({
  notifications: z.array(notificationSchema),
  indicator: z.enum(["error", "warning", "none"])
});

export const credentialCheckSchema = z.object({
  state: z.enum(["ok", "missing", "invalid", "unknown"]),
  checkedAt: z.string()
});

export const balanceStateSchema = z.union([
  z.object({ state: z.literal("known"), amountMicroUsd: microUsdSchema, checkedAt: z.string() }),
  z.object({ state: z.literal("unknown"), amountMicroUsd: z.null(), checkedAt: z.string() })
]);

export const providerHealthSchema = z.object({
  huggingface: credentialCheckSchema,
  vastai: credentialCheckSchema,
  balance: balanceStateSchema,
  thresholdMicroUsd: microUsdSchema
});

export const ipcChannelSchema = z.enum(ipcChannels);

export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type AppInfo = z.infer<typeof appInfoSchema>;
export type AppSettings = z.infer<typeof appSettingsSchema>;
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;
export type CredentialProvider = z.infer<typeof credentialProviderSchema>;
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;
export type CredentialTestResult = z.infer<typeof credentialTestResultSchema>;
export type IpcChannel = z.infer<typeof ipcChannelSchema>;
export type Notification = z.infer<typeof notificationSchema>;
export type NotificationSnapshot = z.infer<typeof notificationSnapshotSchema>;
export type CredentialCheck = z.infer<typeof credentialCheckSchema>;
export type BalanceState = z.infer<typeof balanceStateSchema>;
export type ProviderHealth = z.infer<typeof providerHealthSchema>;
export type UpdatePhase = z.infer<typeof updatePhaseSchema>;
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail(
  code: ErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>
): Result<never> {
  return { ok: false, error: { code, message, retryable, ...(details ? { details } : {}) } };
}
