import { z } from "zod";
import { releaseChannelSchema } from "./domain";

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
  "update.status",
  "update.check",
  "update.download",
  "update.install"
] as const;

/** Main -> renderer push channel used for update status changes. */
export const updateEventChannel = "update.event" as const;

export const DEFAULT_DIAGNOSTICS_URL = "http://localhost:8787";

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
  diagnosticsUrl: httpUrlSchema
});

export const settingsUpdateSchema = appSettingsSchema.partial();

export const ipcChannelSchema = z.enum(ipcChannels);

export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type AppInfo = z.infer<typeof appInfoSchema>;
export type AppSettings = z.infer<typeof appSettingsSchema>;
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;
export type IpcChannel = z.infer<typeof ipcChannelSchema>;
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
