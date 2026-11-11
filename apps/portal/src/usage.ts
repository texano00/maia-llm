import type { FastifyInstance, FastifyRequest } from "fastify";
import { UsageError, type UsageService } from "./services/usage-service.js";

export interface UsageRouteOptions {
  /** Enforced only when the deployment requires installation credentials. */
  authorize?: ((request: FastifyRequest) => Promise<string | null>) | undefined;
}

/**
 * The first hop of `X-Forwarded-For` is the client behind the reverse proxy;
 * without it Fastify's socket address is used. The value is stored with the
 * sample and never logged.
 */
export function observedAddress(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : request.ip;
}

export function registerUsageRoutes(
  app: FastifyInstance,
  usage: UsageService,
  options: UsageRouteOptions,
): void {
  app.post("/api/v0/usage", async (request, reply) => {
    if (options.authorize) {
      const installationId = await options.authorize(request);
      if (!installationId) {
        return reply.status(401).send({ error: "not_authenticated" });
      }
    }

    try {
      await usage.ingest(request.body, observedAddress(request));
      return reply.status(202).send({ accepted: true });
    } catch (error) {
      if (error instanceof UsageError) {
        return reply.status(error.status).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  for (const [path, optedOut] of [
    ["/api/v0/usage/opt-in", false],
    ["/api/v0/usage/opt-out", true],
  ] as const) {
    app.post(path, async (request, reply) => {
      if (options.authorize) {
        const installationId = await options.authorize(request);
        if (!installationId) {
          return reply.status(401).send({ error: "not_authenticated" });
        }
      }

      try {
        await usage.setPreference(request.body, optedOut);
        return reply.status(202).send({ accepted: true });
      } catch (error) {
        if (error instanceof UsageError) {
          return reply.status(error.status).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    });
  }
}
