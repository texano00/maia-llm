export class ProviderHttpError extends Error {
  constructor(
    public readonly code: "PROVIDER_UNAVAILABLE" | "RATE_LIMITED" | "NOT_AUTHENTICATED",
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
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
          throw new ProviderHttpError(
            "NOT_AUTHENTICATED",
            "Provider rejected the credentials",
            false,
            response.status
          );
        }

        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;

        if (retryable && attempt < this.maxRetries) {
          await this.sleep(this.retryDelay(attempt, response));
          attempt += 1;
          continue;
        }

        throw new ProviderHttpError(
          response.status === 429 ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE",
          `Provider request failed with status ${response.status}`,
          retryable,
          response.status
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
          "Provider request failed",
          true
        );
      }
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
