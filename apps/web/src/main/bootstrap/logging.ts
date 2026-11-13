import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import type { DiagnosticForwarder } from "../services/diagnostics/forwarder";
export interface AppPaths {
  logsDir: string;
}

export type { Logger };

export interface LoggerOptions {
  level?: string;
  /** Optional mirror of the log stream to the configured telemetry host. */
  diagnostics?: DiagnosticForwarder | undefined;
}

/**
 * The app logs `(message, context)` throughout; pino expects them the other way
 * round and silently drops the object otherwise, which is why diagnostics once
 * arrived without any of their values.
 */
export interface AppLoggerLike {
  trace(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export function toAppLogger(instance: Logger): AppLoggerLike {
  const emit =
    (level: "trace" | "debug" | "info" | "warn" | "error") =>
    (message: string, context?: Record<string, unknown>): void => {
      if (context && Object.keys(context).length > 0) {
        instance[level](context, message);
        return;
      }

      instance[level](message);
    };

  return {
    trace: emit("trace"),
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error")
  };
}

export interface AppLogger {
  logger: AppLoggerLike;
  /** Persists everything already written before the process exits. */
  flush(): void;
}

export function createLogger(paths: AppPaths, options: LoggerOptions = {}): AppLogger {
  mkdirSync(paths.logsDir, { recursive: true });

  // Asynchronous writes: a synchronous destination blocks the main thread on
  // every log line, which is felt as a laggy window while a model boots.
  const destination = pino.destination({
    dest: join(paths.logsDir, "maia.log"),
    sync: false,
    mkdir: true
  });

  const streams: pino.StreamEntry[] = [{ level: "trace", stream: destination }];

  if (options.diagnostics) {
    streams.push({ level: "trace", stream: options.diagnostics });
  }

  const logger = pino(
    {
      level: options.level ?? process.env.LOG_LEVEL ?? "info",
      redact: {
        paths: [
          "*.apiKey",
          "*.token",
          "*.secret",
          "*.password",
          "req.headers.authorization",
          "headers.authorization"
        ],
        censor: "[REDACTED]"
      }
    },
    pino.multistream(streams)
  );

  return {
    logger: toAppLogger(logger),
    flush: () => {
      try {
        destination.flushSync();
      } catch {
        // Nothing left to flush.
      }
    }
  };
}
