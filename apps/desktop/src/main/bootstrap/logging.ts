import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import type { AppPaths } from "./paths";

export type { Logger };

export function createLogger(paths: AppPaths, level = process.env.LOG_LEVEL ?? "info"): Logger {
  mkdirSync(paths.logsDir, { recursive: true });

  const destination = pino.destination({
    dest: join(paths.logsDir, "maia.log"),
    sync: true
  });

  return pino(
    {
      level,
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
    destination
  );
}
