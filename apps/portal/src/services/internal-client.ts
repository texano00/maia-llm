import { z } from "zod";

/**
 * The product is a separate service with its own module resolution and deploy
 * lifecycle, so the portal keeps its own copy of the wire shapes, like
 * `reputation-contract.ts` does. Keep in sync with
 * `packages/contracts/src/{capabilities,internal}.ts`.
 */
export const capabilitySchema = z.enum(["debug", "operator"]);

export type Capability = z.infer<typeof capabilitySchema>;

export const accountSummarySchema = z.object({
  id: z.string().min(1),
  email: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  capabilities: z.array(capabilitySchema),
  activeSessions: z.number().int().nonnegative()
});

export type AccountSummary = z.infer<typeof accountSummarySchema>;

export const accountListSchema = z.object({
  total: z.number().int().nonnegative(),
  accounts: z.array(accountSummarySchema)
});


/**
 * The detail projection. Every section is optional-tolerant so a product one
 * release behind still renders: the page shows what it received and says what is
 * missing, instead of failing whole.
 */
export const accountDetailRunSchema = z.object({
  id: z.string(),
  modelId: z.string(),
  state: z.string(),
  endReason: z.string().nullable().optional(),
  startedAt: z.string(),
  endedAt: z.string().nullable().optional(),
  durationSeconds: z.number().nullable().optional(),
  rateMicroUsd: z.number().optional(),
  hourlyRateMicroUsd: z.number().optional(),
  simulated: z.boolean().optional(),
  host: z.string().nullable().optional(),
  gpu: z.string().nullable().optional(),
  elapsedSeconds: z.number().optional(),
  accruedMicroUsd: z.number().optional()
});

export const accountDetailSchema = z.object({
  account: accountSummarySchema,
  now: z.array(accountDetailRunSchema).default([]),
  history: z.object({
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    runs: z.array(accountDetailRunSchema)
  }),
  usage: z.object({
    available: z.boolean(),
    windowDays: z.number().int().positive(),
    runs: z.number().optional(),
    outputTokens: z.number().optional(),
    avgTokensPerSecond: z.number().nullable().optional(),
    spendMicroUsd: z.number().optional(),
    outcomes: z.record(z.string(), z.number()).optional()
  }),
  storage: z.object({
    conversations: z.number(),
    messages: z.number(),
    images: z.number(),
    oldestAt: z.string().nullable(),
    newestAt: z.string().nullable()
  }),
  settings: z.record(z.string(), z.unknown()),
  credentials: z.array(
    z.object({
      provider: z.string(),
      present: z.boolean(),
      status: z.string(),
      lastVerifiedAt: z.string().nullable()
    })
  )
});

/** The product's `/health`: which build answers, and whether it rents GPUs. */
export const productInfoSchema = z.object({
  ok: z.boolean().optional(),
  version: z.string().min(1),
  mode: z.string().min(1)
});

export type AccountDetail = z.infer<typeof accountDetailSchema>;
export type AccountDetailRun = z.infer<typeof accountDetailRunSchema>;

/**
 * Typed client for the product's `/internal/*` API. It is the portal's only way
 * to learn who exists and to change a capability; the token it carries never
 * leaves the server half of the portal, and signing in does not use it.
 */

export interface InternalClientOptions {
  /** `MAIA_WEB_INTERNAL_URL`, e.g. `http://maia-web:5173`. */
  baseUrl: string;
  /** `MAIA_INTERNAL_TOKEN`; absent means the API is not available. */
  token: string | null;
  /** Per-request ceiling so a stuck product cannot wedge the portal. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** `status` is the HTTP status, `code` the body's `error` field when present. */
export class InternalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string
  ) {
    super(message ?? `Internal API answered ${status} (${code})`);
    this.name = "InternalApiError";
  }
}

/** What the rest of the portal needs from the product; faked in tests. */
export interface InternalAccountsApi {
  readonly configured: boolean;
  listAccounts(query: {
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ total: number; accounts: AccountSummary[] }>;
  findAccount(email: string): Promise<AccountSummary | null>;
  changeCapability(
    accountId: string,
    change: { grant?: Capability; revoke?: Capability }
  ): Promise<AccountSummary>;
  /** Which product build is behind the backoffice, and its provider mode. */
  productInfo(): Promise<{ version: string; mode: string }>;
  /** Everything the detail page shows, in one request. */
  accountDetail(
    accountId: string,
    query?: { windowDays?: number; limit?: number; offset?: number }
  ): Promise<AccountDetail>;
}

export class InternalClient implements InternalAccountsApi {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: InternalClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** False when the deployment did not configure the shared secret. */
  get configured(): boolean {
    return Boolean(this.options.token);
  }

  async listAccounts(query: {
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ total: number; accounts: AccountSummary[] }> {
    const params = new URLSearchParams();
    if (query.search) {
      params.set("query", query.search);
    }
    params.set("limit", String(query.limit ?? 50));
    params.set("offset", String(query.offset ?? 0));

    const body = await this.request(`/internal/accounts?${params.toString()}`, { method: "GET" });
    const parsed = accountListSchema.safeParse(body);
    if (!parsed.success) {
      throw new InternalApiError(502, "invalid_response");
    }

    return parsed.data;
  }

  /**
   * Re-reads one account by address. This is how a revoked operator loses access
   * at once: every portal request resolves the session's account again instead of
   * trusting a cached capability.
   */
  async findAccount(email: string): Promise<AccountSummary | null> {
    const page = await this.listAccounts({ search: email, limit: 200, offset: 0 });
    const wanted = email.trim().toLowerCase();
    return page.accounts.find((entry) => entry.email.toLowerCase() === wanted) ?? null;
  }

  async changeCapability(
    accountId: string,
    change: { grant?: Capability; revoke?: Capability }
  ): Promise<AccountSummary> {
    const body = await this.post(`/internal/accounts/${encodeURIComponent(accountId)}/capabilities`, {
      ...change,
      confirm: true
    });
    const parsed = accountSummarySchema.safeParse(body);
    if (!parsed.success) {
      throw new InternalApiError(502, "invalid_response");
    }

    return parsed.data;
  }

  async productInfo(): Promise<{ version: string; mode: string }> {
    // `/health` is unauthenticated by design: it says which build answers, not
    // who is signed in.
    const body = await this.requestHealth();
    const parsed = productInfoSchema.safeParse(body);
    if (!parsed.success) {
      throw new InternalApiError(502, "invalid_response");
    }

    return parsed.data;
  }

  private async requestHealth(): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        method: "GET",
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw new InternalApiError(response.status, "unavailable");
      }

      return text.length > 0 ? safeJson(text) : null;
    } catch (error) {
      if (error instanceof InternalApiError) {
        throw error;
      }
      throw new InternalApiError(503, "unavailable", error instanceof Error ? error.message : undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  async accountDetail(
    accountId: string,
    query: { windowDays?: number; limit?: number; offset?: number } = {}
  ): Promise<AccountDetail> {
    const params = new URLSearchParams();
    params.set("windowDays", String(query.windowDays ?? 30));
    params.set("limit", String(query.limit ?? 20));
    params.set("offset", String(query.offset ?? 0));

    const body = await this.request(
      `/internal/accounts/${encodeURIComponent(accountId)}?${params.toString()}`,
      { method: "GET" }
    );
    const parsed = accountDetailSchema.safeParse(body);
    if (!parsed.success) {
      throw new InternalApiError(502, "invalid_response");
    }

    return parsed.data;
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const token = this.options.token;
    if (!token) {
      throw new InternalApiError(503, "not_configured", "MAIA_INTERNAL_TOKEN is not set");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), "x-maia-internal": token },
        signal: controller.signal
      });

      const text = await response.text();
      const parsed: unknown = text.length > 0 ? safeJson(text) : null;

      if (!response.ok) {
        const code =
          parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
            ? ((parsed as { error: string }).error)
            : "unavailable";
        throw new InternalApiError(response.status, code);
      }

      return parsed;
    } catch (error) {
      if (error instanceof InternalApiError) {
        throw error;
      }

      // A refused connection or a timeout is reported the same way, so callers
      // have one failure to handle.
      throw new InternalApiError(503, "unavailable", error instanceof Error ? error.message : undefined);
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
