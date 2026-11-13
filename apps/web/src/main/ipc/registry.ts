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

type IpcHandler<T> = (payload: T) => Promise<unknown> | unknown;

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
   * Runs one channel with the same validation and error mapping used by IPC, so
   * the web host can reuse every handler without Electron.
   */
  async invoke(channel: IpcChannel, payload: unknown): Promise<Result<unknown>> {
    const registration = this.registrations.get(channel);
    if (!registration) {
      return fail("VALIDATION_FAILED", `Unsupported IPC channel: ${channel}`, false);
    }

    const parsed = registration.schema.safeParse(payload);
    if (!parsed.success) {
      return fail("VALIDATION_FAILED", "Request payload is invalid", false);
    }

    try {
      const data = await registration.handler(parsed.data);
      return ok(data);
    } catch (error) {
      this.onError?.(channel, error);
      return fail(errorToCode(error), toSafeMessage(error), false);
    }
  }

}

function toSafeMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "Unexpected application error";
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
