import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminCookie,
  adminSessionToken,
  clearedAdminCookie
} from "./auth.js";
import { createOperatorGuard } from "./operator-guard.js";
import type { AdminAuthService, TokenService } from "./services/portal-auth.js";
import { InternalApiError, type InternalAccountsApi } from "./services/internal-client.js";

const enrollSchema = z.object({
  installId: z.string().min(8).max(128),
  appVersion: z.string().max(64).nullish(),
  platform: z.string().max(64).nullish()
});

const refreshSchema = z.object({ refreshToken: z.string().min(16).max(256) });

const requestCodeSchema = z.object({
  email: z.string().min(3).max(254)
});

const signInSchema = z.object({
  email: z.string().min(3).max(254),
  code: z.string().min(4).max(12)
});

export interface PortalAuthRouteOptions {
  tokens: TokenService;
  admins: AdminAuthService;
  /** Reaches the product: the portal has no identities of its own. */
  internal: InternalAccountsApi;
  /** `Secure` cookie attribute; off for plain-http local development. */
  secureCookies: boolean;
  /** Injected so the contract tests can use a fixed clock. */
  now?: () => number;
}

const MAX_INSTALLATIONS = 500;

/**
 * Enrollment, token refresh and the administrator session.
 *
 * Enrollment is deliberately open (rate limited by the deployment): a desktop
 * installation must be able to obtain a credential without an account. What it
 * cannot do is keep one after an administrator revokes it.
 */
export function registerPortalAuthRoutes(app: FastifyInstance, options: PortalAuthRouteOptions): void {
  const { tokens, admins, internal } = options;
  const now = options.now ?? (() => Date.now());
  const requireOperator = createOperatorGuard({ admins, internal });

  const requireAdmin = async (request: FastifyRequest): Promise<string | null> =>
    (await requireOperator(request))?.accountId ?? null;

  app.post("/v1/installations", async (request, reply) => {
    const parsed = enrollSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload" });
    }

    const credentials = await tokens.enroll(parsed.data);
    return reply.status(201).send(credentials);
  });

  app.post("/v1/installations/refresh", async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload" });
    }

    const credentials = await tokens.refresh(parsed.data.refreshToken);
    if (!credentials) {
      return reply.status(401).send({ error: "invalid_refresh_token" });
    }

    return reply.status(200).send(credentials);
  });

  // Step one: the product sends the code with its own mail transport, throttles and
  // captcha policy. The portal never learns whether the address exists.
  app.post("/v1/admin/code", async (request, reply) => {
    const parsed = requestCodeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload" });
    }

    try {
      await internal.requestCode(parsed.data.email);
      return reply.status(202).send({ sent: true });
    } catch (error) {
      const mapped = mapInternalFailure(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  // Step two: the product verifies the code and reports capabilities. Only an
  // operator gets a portal session; everyone else sees the wrong-code answer, so
  // the login cannot be used to find out who is an operator.
  app.post("/v1/admin/session", async (request, reply) => {
    const parsed = signInSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload" });
    }

    let identity;
    try {
      identity = await internal.verifyCode(parsed.data.email, parsed.data.code);
    } catch (error) {
      const mapped = mapInternalFailure(error);
      return reply.status(mapped.status).send(mapped.body);
    }

    if (!identity.capabilities.includes("operator")) {
      return reply.status(401).send({ error: "invalid_credentials" });
    }

    const session = await admins.signInVerified(identity.accountId, identity.email);
    const ttlSeconds = Math.max(1, Math.round((Date.parse(session.expiresAt) - now()) / 1000));
    reply.header("set-cookie", adminCookie(session.sessionToken, ttlSeconds, options.secureCookies));

    return reply.status(200).send({ email: session.email, expiresAt: session.expiresAt });
  });

  app.delete("/v1/admin/session", async (request, reply) => {
    const token = adminSessionToken(request);
    if (token) {
      await admins.signOut(token);
    }

    reply.header("set-cookie", clearedAdminCookie(options.secureCookies));
    return reply.status(204).send();
  });

  app.get("/v1/admin/installations", async (request, reply) => {
    if (!(await requireAdmin(request))) {
      return reply.status(401).send({ error: "not_authenticated" });
    }

    const query = (request.query ?? {}) as Record<string, unknown>;
    const raw = Number(query.limit ?? 100);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), MAX_INSTALLATIONS) : 100;

    return { installations: await tokens.listInstallations(limit), serverTime: new Date(now()).toISOString() };
  });

  app.delete("/v1/admin/installations/:id", async (request, reply) => {
    if (!(await requireAdmin(request))) {
      return reply.status(401).send({ error: "not_authenticated" });
    }

    const id = (request.params as { id?: string }).id ?? "";
    const revoked = await tokens.revokeInstallation(id, "admin");

    return revoked ? reply.status(204).send() : reply.status(404).send({ error: "unknown_installation" });
  });

  // A session cookie is only useful if the backoffice can tell it is signed in.
  app.get("/v1/admin/session", async (request, reply) => {
    const operator = await requireOperator(request);
    if (!operator) {
      return reply.status(401).send({ error: "not_authenticated" });
    }

    return { email: operator.email };
  });
}

/** Product failures are translated once, so every portal route answers alike. */
function mapInternalFailure(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof InternalApiError) {
    if (error.status === 429) {
      return { status: 429, body: { error: "throttled" } };
    }

    if (error.status === 401) {
      // A wrong or expired code is not an authentication failure of the portal.
      return { status: 401, body: { error: "invalid_credentials" } };
    }

    if (error.status === 400) {
      return { status: 400, body: { error: "invalid_payload" } };
    }

    return { status: 503, body: { error: "unavailable" } };
  }

  return { status: 503, body: { error: "unavailable" } };
}
