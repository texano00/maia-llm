export type ProviderErrorCode = "PROVIDER_UNAVAILABLE" | "RATE_LIMITED" | "NOT_AUTHENTICATED" | "INVALID_REQUEST";

export interface ProviderFailureDetails {
  method?: string | undefined;
  path?: string | undefined;
  /** Response body, already truncated; kept so the UI can show what the provider said. */
  body?: string | undefined;
}

export class ProviderHttpError extends Error {
  public readonly method: string | undefined;
  public readonly path: string | undefined;
  public readonly body: string | undefined;

  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    details: ProviderFailureDetails = {}
  ) {
    super(message);
    this.name = "ProviderHttpError";
    this.method = details.method;
    this.path = details.path;
    this.body = details.body;
  }
}

const BODY_EXCERPT_LIMIT = 300;

/**
 * Providers answer with their own explanation (`{"success":false,"error":
 * "invalid_args","msg":"... no_such_ask ..."}`), so a bare "status 400" hides the
 * only useful part. Pull the human sentence out of the payload.
 */
export function extractProviderMessage(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const payload: unknown = JSON.parse(trimmed);
    if (typeof payload === "string") {
      return payload.slice(0, BODY_EXCERPT_LIMIT);
    }

    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      const firstText = (...keys: string[]): string | null => {
        for (const key of keys) {
          const value = record[key];
          if (typeof value === "string" && value.trim().length > 0) {
            return value.trim();
          }
        }
        return null;
      };

      const primary = firstText("msg", "message", "detail", "error_message");
      const code = firstText("error");
      const sentence =
        primary && code && code !== primary
          ? `${primary} [${code}]`
          : (primary ?? code);

      if (sentence) {
        return sentence.slice(0, BODY_EXCERPT_LIMIT);
      }

      if (Array.isArray(record.errors)) {
        return record.errors.map((entry) => String(entry)).join("; ").slice(0, BODY_EXCERPT_LIMIT);
      }
    }
  } catch {
    // Not JSON: fall back to the raw excerpt.
  }

  return trimmed.replace(/\s+/g, " ").slice(0, BODY_EXCERPT_LIMIT);
}

function shortenPath(path: string): string {
  return path.length > 160 ? `${path.slice(0, 160)}…` : path;
}

/**
 * `PUT /api/v0/asks/42/ failed with status 400: invalid_args — error 404/3603:
 * no_such_ask …` — enough to diagnose without opening a log.
 */
export function describeFailure(
  method: string,
  path: string,
  status: number,
  body: string | undefined,
  fallback: string
): string {
  const providerMessage = body ? extractProviderMessage(body) : null;
  const head = `${method} ${path} failed with status ${status}`;

  return providerMessage ? `${head}: ${providerMessage}` : `${head} (${fallback})`;
}

export interface ProviderHttpClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class ProviderHttpClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly minIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextAllowedAt = 0;

  constructor(private readonly options: ProviderHttpClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.options.baseUrl).toString();
    const method = (init.method ?? "GET").toUpperCase();
    const requestPath = shortenPath(path);
    let attempt = 0;

    for (;;) {
      await this.waitForRateLimit();

      try {
        const response = await this.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs)
        });

        if (response.ok) {
          return response;
        }

        if (response.status === 401 || response.status === 403) {
          const detail = await this.readFailureBody(response);
          throw new ProviderHttpError(
            "NOT_AUTHENTICATED",
            describeFailure(method, requestPath, response.status, detail, "Provider rejected the credentials"),
            false,
            response.status,
            { method, path: requestPath, body: detail }
          );
        }

        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;

        if (retryable && attempt < this.maxRetries) {
          await this.sleep(this.retryDelay(attempt, response));
          attempt += 1;
          continue;
        }

        const detail = await this.readFailureBody(response);
        const code: ProviderErrorCode =
          response.status === 429
            ? "RATE_LIMITED"
            : retryable
              ? "PROVIDER_UNAVAILABLE"
              : "INVALID_REQUEST";

        throw new ProviderHttpError(
          code,
          describeFailure(method, requestPath, response.status, detail, "Provider request failed"),
          retryable,
          response.status,
          { method, path: requestPath, body: detail }
        );
      } catch (error) {
        if (error instanceof ProviderHttpError) {
          throw error;
        }

        if (attempt < this.maxRetries) {
          await this.sleep(this.retryDelay(attempt));
          attempt += 1;
          continue;
        }

        throw new ProviderHttpError(
          "PROVIDER_UNAVAILABLE",
          `${method} ${requestPath} failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
          undefined,
          { method, path: requestPath }
        );
      }
    }
  }

  /** Body text is only read when the request is about to fail, so retries stay cheap. */
  private async readFailureBody(response: Response): Promise<string | undefined> {
    try {
      return await response.text();
    } catch {
      return undefined;
    }
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    return (await response.json()) as T;
  }

  private retryDelay(attempt: number, response?: Response): number {
    const retryAfter = response?.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
      }
    }

    return this.retryBaseMs * 2 ** attempt;
  }

  private async waitForRateLimit(): Promise<void> {
    if (this.minIntervalMs <= 0) {
      return;
    }

    const now = Date.now();
    if (now < this.nextAllowedAt) {
      await this.sleep(this.nextAllowedAt - now);
    }

    this.nextAllowedAt = Date.now() + this.minIntervalMs;
  }
}
