import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { ZodType } from "zod";
import { fail, ok, type ApiError, type IpcChannel, type Result } from "@maia/contracts";

type IpcHandler<T> = (payload: T) => Promise<unknown> | unknown;

interface Registration {
  schema: ZodType;
  handler: IpcHandler<unknown>;
}

export interface IpcRegistryOptions {
  isSenderAllowed?: (event: IpcMainInvokeEvent) => boolean;
}

export class IpcRegistry {
  private readonly registrations = new Map<IpcChannel, Registration>();
  private readonly isSenderAllowed: (event: IpcMainInvokeEvent) => boolean;

  constructor(options: IpcRegistryOptions = {}) {
    this.isSenderAllowed = options.isSenderAllowed ?? defaultSenderAllowed;
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

  install(): void {
    for (const [channel, registration] of this.registrations) {
      ipcMain.handle(channel, async (event, payload: unknown): Promise<Result<unknown>> => {
        if (!this.isSenderAllowed(event)) {
          return fail("NOT_AUTHENTICATED", "Request came from an untrusted renderer", false);
        }

        const parsed = registration.schema.safeParse(payload);
        if (!parsed.success) {
          return fail("VALIDATION_FAILED", "Request payload is invalid", false);
        }

        try {
          const data = await registration.handler(parsed.data);
          return ok(data);
        } catch (error) {
          return fail("INTERNAL", toSafeMessage(error), false);
        }
      });
    }
  }

  dispose(): void {
    for (const channel of this.registrations.keys()) {
      ipcMain.removeHandler(channel);
    }

    this.registrations.clear();
  }
}

function defaultSenderAllowed(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url;
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "file:" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1"
    );
  } catch {
    return false;
  }
}

function toSafeMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "Unexpected application error";
}

export type { ApiError };
