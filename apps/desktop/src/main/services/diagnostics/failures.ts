import type { FailureEvent, FailureReport } from "@maia/contracts";

export interface FailureReporterOptions {
  /** Diagnostics URL: host, `/v1/failures`, or the log-mirror endpoint. */
  url: string | (() => string);
  appVersion: string;
  platform: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Pause between the two attempts; tests set it to 0. */
  retryDelayMs?: number;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

/**
 * Where a failure report goes, derived from the configured diagnostics URL.
 *
 * Users configure one host for diagnostics; the log mirror and the failure sink
 * live on the same service, so a value that already points at
 * `/v1/diagnostics/logs` is rewritten rather than doubled up.
 */
export function failureEndpoint(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");

  if (trimmed.endsWith("/v1/diagnostics/logs")) {
    return trimmed.replace(/\/v1\/diagnostics\/logs$/, "/v1/failures");
  }

  return trimmed.endsWith("/v1/failures") ? trimmed : `${trimmed}/v1/failures`;
}

/**
 * Removes anything that must not leave the machine: provider tokens, bearer
 * headers and absolute home paths. The container log is third-party text, so
 * this runs on every report rather than on a best-effort basis.
 */
export function scrubFailureText(text: string, limit = 4_000): string {
  const scrubbed = text
    .replace(/\bhf_[A-Za-z0-9]{8,}\b/g, "hf_***")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(
      /\b(VAST_API_KEY|HF_TOKEN|HUGGING_FACE_HUB_TOKEN|MAIA_[A-Z_]*(?:TOKEN|KEY|SECRET))\s*=\s*\S+/g,
      "$1=***"
    )
    .replace(/(?:\/home|\/Users|\/root)\/[^\s:'"]+/g, "<path>")
    .replace(/[A-Za-z]:\\Users\\[^\s:'"]+/g, "<path>")
    .replace(/[A-Za-z]:\\[^\s:'"]*\\AppData\\[^\s:'"]*/g, "<path>");

  return scrubbed.length > limit ? scrubbed.slice(-limit) : scrubbed;
}

/**
 * Fire-and-forget reporter for failed start-ups.
 *
 * A session that cannot start is the one moment the app has information nobody
 * else will ever see (the container dies with the instance), so the report is
 * attempted twice and then dropped: diagnostics must never delay or fail the
 * user's teardown path.
 */
export function createFailureReporter(options: FailureReporterOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const now = options.now ?? (() => Date.now());

  async function deliver(endpoint: string, report: FailureReport): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(report),
          signal: AbortSignal.timeout(5_000)
        });

        if (response.ok) {
          return true;
        }
      } catch {
        // Offline or the service is down: retry once, then give up quietly.
      }

      if (retryDelayMs > 0 && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    return false;
  }

  return (event: FailureEvent): void => {
    const report: FailureReport = {
      appVersion: options.appVersion,
      platform: options.platform,
      occurredAt: new Date(now()).toISOString(),
      ...event,
      ...(event.errorMessage ? { errorMessage: scrubFailureText(event.errorMessage, 2_000) } : {}),
      ...(event.rootCause ? { rootCause: scrubFailureText(event.rootCause, 400) } : {}),
      ...(event.logTail ? { logTail: scrubFailureText(event.logTail) } : {})
    };

    const configured = typeof options.url === "function" ? options.url() : options.url;
    const endpoint = failureEndpoint(configured);

    void deliver(endpoint, report).then((ok) => {
      if (!ok) {
        options.logger?.warn("Failure report could not be delivered", {
          modelId: event.modelId ?? null,
          endpoint
        });
      }
    });
  };
}
