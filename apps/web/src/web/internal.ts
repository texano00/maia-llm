import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  accountDetailQuerySchema,
  capabilityChangeSchema,
  internalAccountQuerySchema,
  type InternalAccountList
} from "@maia/contracts";
import { AccountRepository, LastOperatorError } from "../main/services/accounts/repository";
import { SettingsStore } from "../main/services/settings/store";
import { createAccountDetail } from "../main/services/accounts/detail";
import type { WebPlatform } from "./host";

/** Header the portal presents; compared without leaking length through timing. */
export const INTERNAL_TOKEN_HEADER = "x-maia-internal";

/** Bodies here are a handful of fields; anything larger is not this API. */
const MAX_INTERNAL_BODY_BYTES = 8 * 1024;

export interface InternalRouteOptions {
  platform: WebPlatform;
  /** `MAIA_INTERNAL_TOKEN`; when absent the caller mounts nothing at all. */
  token: string | null;
}

export interface InternalRoutes {
  /**
   * Answers the request when it is an `/internal/*` path. Returns false so the
   * caller can fall through to the static handler.
   */
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
}

/**
 * Server-to-server surface consumed by the portal. It is not part of the RPC
 * transport, is never reachable from the internet, and exposes only identity,
 * capabilities and a session count: no settings, conversations or key material.
 */
export function createInternalRoutes(options: InternalRouteOptions): InternalRoutes | null {
  const { token } = options;
  if (!token) {
    // Unset token means the routes do not exist: every path answers 404 from the
    // static handler, which is also what a scanner should see.
    return null;
  }

  const repository = new AccountRepository(options.platform.database);
  const expectedToken = token;
  const project = createAccountDetail({
    repository,
    settings: (accountId) => new SettingsStore(options.platform.database, accountId).get()
  });

  const detailFor = (
    accountId: string,
    query: { windowDays: number; limit: number; offset: number }
  ) => project({ accountId, ...query });

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): Promise<boolean> {
    if (!url.pathname.startsWith("/internal/")) {
      return false;
    }

    if (!authorized(request.headers[INTERNAL_TOKEN_HEADER], expectedToken)) {
      send(response, 401, { error: "unauthorized" });
      return true;
    }

    try {
      if (url.pathname === "/internal/accounts" && request.method === "GET") {
        const query = internalAccountQuerySchema.safeParse({
          query: url.searchParams.get("query") ?? undefined,
          limit: url.searchParams.get("limit") ?? undefined,
          offset: url.searchParams.get("offset") ?? undefined
        });
        if (!query.success) {
          send(response, 400, { error: "invalid_request" });
          return true;
        }

        const page: InternalAccountList = repository.listAccountSummaries({
          ...(query.data.query ? { search: query.data.query } : {}),
          limit: query.data.limit,
          offset: query.data.offset
        });
        send(response, 200, page);
        return true;
      }

      const detailMatch = /^\/internal\/accounts\/([^/]+)$/.exec(url.pathname);
      if (detailMatch && request.method === "GET") {
        const parsed = accountDetailQuerySchema.safeParse({
          windowDays: url.searchParams.get("windowDays") ?? undefined,
          limit: url.searchParams.get("limit") ?? undefined,
          offset: url.searchParams.get("offset") ?? undefined
        });
        if (!parsed.success) {
          send(response, 400, { error: "invalid_request" });
          return true;
        }

        const detail = detailFor(decodeURIComponent(detailMatch[1] ?? ""), parsed.data);
        if (!detail) {
          send(response, 404, { error: "not_found" });
          return true;
        }

        send(response, 200, detail);
        return true;
      }

      const capabilityMatch = /^\/internal\/accounts\/([^/]+)\/capabilities$/.exec(url.pathname);
      if (capabilityMatch && request.method === "POST") {
        const accountId = decodeURIComponent(capabilityMatch[1] ?? "");
        const body = capabilityChangeSchema.safeParse(await readJson(request));
        if (!body.success) {
          send(response, 400, { error: "invalid_request" });
          return true;
        }

        const account = repository.findAccountById(accountId);
        if (!account) {
          send(response, 404, { error: "not_found" });
          return true;
        }

        if (body.data.grant) {
          repository.grantCapability(accountId, body.data.grant);
        } else if (body.data.revoke) {
          repository.revokeCapability(accountId, body.data.revoke);
        }

        send(response, 200, repository.accountSummary(accountId));
        return true;
      }

      send(response, 404, { error: "not_found" });
      return true;
    } catch (error) {
      if (error instanceof LastOperatorError) {
        send(response, 409, { error: "last-operator" });
        return true;
      }

      const mapped = mapAccessError(error);
      send(response, mapped.status, mapped.body);
      return true;
    }
  }

  return { handle };
}

/** Access errors carry a product `code`; the portal only needs the status. */
function mapAccessError(error: unknown): { status: number; body: Record<string, unknown> } {
  const code = (error as { code?: string } | null)?.code;
  const details = (error as { details?: Record<string, unknown> } | null)?.details;

  if (code === "RATE_LIMITED") {
    return {
      status: 429,
      body: {
        error: "throttled",
        ...(typeof details?.retryAfterSeconds === "number"
          ? { retryAfterSeconds: details.retryAfterSeconds }
          : {})
      }
    };
  }

  if (code === "PROVIDER_UNAVAILABLE") {
    return { status: 503, body: { error: "provider_unavailable" } };
  }

  if (code === "NOT_AUTHENTICATED") {
    return { status: 401, body: { error: "unauthorized" } };
  }

  if (code === "VALIDATION_FAILED") {
    return { status: 400, body: { error: "invalid_request" } };
  }

  return { status: 500, body: { error: "internal" } };
}

function authorized(header: string | string[] | undefined, token: string): boolean {
  const presented = Array.isArray(header) ? header[0] : header;
  if (!presented) {
    return false;
  }

  const expected = Buffer.from(token, "utf8");
  const actual = Buffer.from(presented, "utf8");
  // Length is not a secret worth protecting with a padded compare; the values are.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_INTERNAL_BODY_BYTES) {
      throw Object.assign(new Error("Body too large"), { code: "VALIDATION_FAILED" });
    }
    chunks.push(buffer);
  }

  if (size === 0) {
    return null;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw Object.assign(new Error("Malformed JSON"), { code: "VALIDATION_FAILED" });
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}
