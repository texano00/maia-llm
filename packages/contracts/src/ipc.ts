import { z } from "zod";

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
  platform: z.string()
});

export const ipcChannels = ["app.info"] as const;

export const ipcChannelSchema = z.enum(ipcChannels);

export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type AppInfo = z.infer<typeof appInfoSchema>;
export type IpcChannel = z.infer<typeof ipcChannelSchema>;

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
