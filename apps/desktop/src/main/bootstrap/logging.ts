import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import type { DiagnosticForwarder } from "../services/diagnostics/forwarder";
import type { AppPaths } from "./paths";

export type { Logger };

export interface LoggerOptions {
  level?: string;
  /** Optional mirror of the log stream to the configured telemetry host. */
  diagnostics?: DiagnosticForwarder | undefined;
}

export interface AppLogger {
  logger: Logger;
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
    logger,
    flush: () => {
      try {
        destination.flushSync();
      } catch {
        // Nothing left to flush.
      }
    }
  };
}
