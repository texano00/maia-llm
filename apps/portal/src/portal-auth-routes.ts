import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  adminCookie,
  adminSessionToken,
  clearedAdminCookie
} from "./auth.js";
import type { AdminAuthService, TokenService } from "./services/portal-auth.js";

const enrollSchema = z.object({
  installId: z.string().min(8).max(128),
  appVersion: z.string().max(64).nullish(),
  platform: z.string().max(64).nullish()
});

const refreshSchema = z.object({ refreshToken: z.string().min(16).max(256) });

const signInSchema = z.object({
  email: z.string().min(3).max(200),
  password: z.string().min(1).max(200)
});

export interface PortalAuthRouteOptions {
  tokens: TokenService;
  admins: AdminAuthService;
  /** `Secure` cookie attribute; off for plain-http local development. */
  secureCookies: boolean;
  /** Injected so the contract tests can use a fixed clock. */
  now?: () => number;
}


/**
 * Enrollment, token refresh and the administrator session.
 *
 * Enrollment is deliberately open (rate limited by the deployment): an
 * installation must be able to obtain a credential without an account. What it
 * cannot do is keep one after an administrator revokes it.
 */
export function registerPortalAuthRoutes(app: FastifyInstance, options: PortalAuthRouteOptions): void {
  const { tokens, admins } = options;
  const now = options.now ?? (() => Date.now());


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

  app.post("/v1/admin/session", async (request, reply) => {
    const parsed = signInSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload" });
    }

    const session = await admins.signIn(parsed.data.email, parsed.data.password);
    if (!session) {
      return reply.status(401).send({ error: "invalid_credentials" });
    }

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

  // A session cookie is only useful if the backoffice can tell it is signed in.
  app.get("/v1/admin/session", async (request, reply) => {
    const token = adminSessionToken(request);
    const session = token ? await admins.sessionFor(token) : null;

    if (!session) {
      return reply.status(401).send({ error: "not_authenticated" });
    }

    return { email: session.email };
  });
}
