import { Writable } from "node:stream";

export interface DiagnosticEvent {
  time: number;
  level: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface DiagnosticForwarderOptions {
  url: string;
  appVersion: string;
  platform: string;
  batchSize?: number;
  flushIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onFailure?: ((error: unknown) => void) | undefined;
}

const LEVEL_NAMES: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal"
};

const MAX_BUFFERED_EVENTS = 500;

/**
 * Development aid that mirrors the local log file to a reachable endpoint, so a
 * packaged app on another machine can be watched live with
 * `MAIA_DIAGNOSTIC_LOG_URL`. It never throws into the logging path and drops the
 * oldest entries when the receiver is unavailable.
 */
export class DiagnosticForwarder extends Writable {
  private readonly options: Required<
    Pick<DiagnosticForwarderOptions, "url" | "appVersion" | "platform" | "batchSize" | "flushIntervalMs" | "timeoutMs">
  >;
  private readonly fetchImpl: typeof fetch;
  private readonly onFailure: ((error: unknown) => void) | undefined;
  private buffer: DiagnosticEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private sending = false;

  constructor(options: DiagnosticForwarderOptions) {
    super({ decodeStrings: false });

    this.options = {
      url: options.url,
      appVersion: options.appVersion,
      platform: options.platform,
      batchSize: options.batchSize ?? 25,
      flushIntervalMs: options.flushIntervalMs ?? 2_000,
      timeoutMs: options.timeoutMs ?? 5_000
    };
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.onFailure = options.onFailure;

    this.timer = setInterval(() => {
      void this.flush();
    }, this.options.flushIntervalMs);
    this.timer.unref?.();
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    try {
      const line = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const event = toDiagnosticEvent(line);

      if (event) {
        this.buffer.push(event);
        if (this.buffer.length > MAX_BUFFERED_EVENTS) {
          this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_EVENTS);
        }
        if (this.buffer.length >= this.options.batchSize) {
          void this.flush();
        }
      }
    } catch {
      // Logging must never break the application.
    }

    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    void this.flush().finally(() => callback());
  }

  async flush(): Promise<void> {
    if (this.sending || this.buffer.length === 0) {
      return;
    }

    const events = this.buffer.splice(0, this.buffer.length);
    this.sending = true;

    try {
      const response = await this.fetchImpl(this.options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          app: "maia-llm",
          version: this.options.appVersion,
          platform: this.options.platform,
          events
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs)
      });

      if (!response.ok) {
        throw new Error(`Diagnostic endpoint returned HTTP ${response.status}`);
      }
    } catch (error) {
      this.onFailure?.(error);
    } finally {
      this.sending = false;
    }
  }
}

export function toDiagnosticEvent(line: string): DiagnosticEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { time: Date.now(), level: "info", message: trimmed };
  }

  const level = typeof parsed.level === "number" ? (LEVEL_NAMES[parsed.level] ?? "info") : "info";
  const message = typeof parsed.msg === "string" ? parsed.msg : "";
  const time = typeof parsed.time === "number" ? parsed.time : Date.now();

  const context: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "level" || key === "msg" || key === "time" || key === "pid" || key === "hostname") {
      continue;
    }
    context[key] = value;
  }

  return {
    time,
    level,
    message,
    ...(Object.keys(context).length > 0 ? { context } : {})
  };
}
