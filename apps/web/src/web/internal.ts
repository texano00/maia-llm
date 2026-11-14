import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  capabilityChangeSchema,
  internalAccountQuerySchema,
  internalRequestCodeSchema,
  internalVerifyCodeSchema,
  type InternalAccountList
} from "@maia/contracts";
import { AccountRepository, LastOperatorError } from "../main/services/accounts/repository";
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
  const access = options.platform.access;
  const expectedToken = token;

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

    const context = {
      sourceAddress: request.socket.remoteAddress ?? "internal",
      userAgent: request.headers["user-agent"] ?? null
    };

    try {
      if (url.pathname === "/internal/auth/request-code" && request.method === "POST") {
        const body = internalRequestCodeSchema.safeParse(await readJson(request));
        if (!body.success) {
          send(response, 400, { error: "invalid_request" });
          return true;
        }

        // The product's own throttles, captcha policy and mail transport apply, so
        // the portal cannot become a way around them.
        await access.requestCode({ email: body.data.email }, context);
        send(response, 200, { sent: true });
        return true;
      }

      if (url.pathname === "/internal/auth/verify-code" && request.method === "POST") {
        const body = internalVerifyCodeSchema.safeParse(await readJson(request));
        if (!body.success) {
          send(response, 400, { error: "invalid_request" });
          return true;
        }

        // No cookie: the portal issues its own session.
        const verified = await access.verifyCode(
          { email: body.data.email, code: body.data.code },
          context
        );
        send(response, 200, {
          accountId: verified.accountId,
          email: verified.result.email,
          capabilities: verified.capabilities
        });
        return true;
      }

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
