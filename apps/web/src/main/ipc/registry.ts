import type { ZodType } from "zod";
import {
  errorCodeSchema,
  fail,
  ok,
  type ApiError,
  type ErrorCode,
  type IpcChannel,
  type Result
} from "@maia/contracts";

type IpcHandler<T> = (payload: T, context: IpcInvokeContext) => Promise<unknown> | unknown;

/**
 * Transport facts a handler may need. The session token is handed here rather
 * than returned, so it never reaches the renderer: the cookie is HttpOnly.
 */
export interface IpcInvokeContext {
  sessionToken?: string | null;
  sourceAddress?: string;
  userAgent?: string | null;
  setSessionCookie?: (token: string, expiresAt: string) => void;
  clearSessionCookie?: () => void;
  /** Mirrors a stored appearance into the pre-paint preference cookie. */
  setAppearance?: (value: "light" | "dark") => void;
}

interface Registration {
  schema: ZodType;
  handler: IpcHandler<unknown>;
}

export interface IpcRegistryOptions {
  onError?: ((channel: IpcChannel, error: unknown) => void) | undefined;
}

export class IpcRegistry {
  private readonly registrations = new Map<IpcChannel, Registration>();
  private readonly onError: ((channel: IpcChannel, error: unknown) => void) | undefined;

  constructor(options: IpcRegistryOptions = {}) {
    this.onError = options.onError;
  }

  register<T>(channel: IpcChannel, schema: ZodType<T>, handler: IpcHandler<T>): void {
    if (this.registrations.has(channel)) {
      throw new Error(`IPC channel already registered: ${channel}`);
    }

    this.registrations.set(channel, {
      schema,
      handler: handler as IpcHandler<unknown>
    });
  }

  /**
   * Runs one channel with the same validation and error mapping used by the RPC
   * transport, so a handler has exactly one way to be called.
   */
  async invoke(
    channel: IpcChannel,
    payload: unknown,
    context: IpcInvokeContext = {}
  ): Promise<Result<unknown>> {
    const registration = this.registrations.get(channel);
    if (!registration) {
      return fail("VALIDATION_FAILED", `Unsupported IPC channel: ${channel}`, false);
    }

    const parsed = registration.schema.safeParse(payload);
    if (!parsed.success) {
      return fail("VALIDATION_FAILED", "Request payload is invalid", false);
    }

    try {
      const data = await registration.handler(parsed.data, context);
      return ok(data);
    } catch (error) {
      this.onError?.(channel, error);
      return fail(errorToCode(error), toSafeMessage(error), isRetryable(error), errorDetails(error));
    }
  }

}

function toSafeMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "Unexpected application error";
}

/** Handlers may mark an error retryable; a bare Error stays non-retryable. */
function isRetryable(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "retryable" in error &&
    (error as { retryable: unknown }).retryable === true
  );
}

/** Extra context the UI needs (for example `retryAfterSeconds`). */
function errorDetails(error: unknown): Record<string, unknown> | undefined {
  if (error === null || typeof error !== "object" || !("details" in error)) {
    return undefined;
  }

  const details = (error as { details: unknown }).details;
  return details !== null && typeof details === "object"
    ? (details as Record<string, unknown>)
    : undefined;
}

function errorToCode(error: unknown): ErrorCode {
  if (error !== null && typeof error === "object" && "code" in error) {
    const parsed = errorCodeSchema.safeParse((error as { code: unknown }).code);
    if (parsed.success) {
      return parsed.data;
    }
  }

  return "INTERNAL";
}

export type { ApiError };
