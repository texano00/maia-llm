import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import { DiagnosticForwarder } from "../services/diagnostics/forwarder";
import type { AppPaths } from "./paths";

export type { Logger };

export interface DiagnosticsOptions {
  url: string;
  appVersion: string;
  platform: string;
}

export interface LoggerOptions {
  level?: string;
  diagnostics?: DiagnosticsOptions | undefined;
}

export function createLogger(paths: AppPaths, options: LoggerOptions = {}): Logger {
  mkdirSync(paths.logsDir, { recursive: true });

  const destination = pino.destination({
    dest: join(paths.logsDir, "maia.log"),
    sync: true
  });

  const streams: pino.StreamEntry[] = [{ level: "trace", stream: destination }];

  if (options.diagnostics) {
    streams.push({
      level: "trace",
      stream: new DiagnosticForwarder(options.diagnostics)
    });
  }

  return pino(
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
}
