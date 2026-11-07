import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SnapshotService } from "./services/catalogue/snapshot-service.js";
import type { UseCaseSummary } from "./services/catalogue/use-cases.js";

export interface ConfigRouteOptions {
  snapshot: SnapshotService;
  useCases: () => Promise<UseCaseSummary[]>;
  /** Present when installation credentials are enforced. */
  authorize?: (request: FastifyRequest) => Promise<string | null>;
}

/**
 * The configs API the desktop catalogue reads.
 *
 * One conditional GET carries the whole catalogue (model facts, artifacts,
 * engine and supported verdict) so the client never calls the model provider and
 * can browse from its last snapshot when this service is down.
 */
export function registerConfigRoutes(app: FastifyInstance, options: ConfigRouteOptions): void {
  app.get("/v1/config/catalogue", async (request, reply) => {
    if (options.authorize) {
      const installationId = await options.authorize(request);
      if (!installationId) {
        return reply.status(401).send({ error: "not_authenticated" });
      }
    }

    const current = await options.snapshot.current();
    if (!current) {
      return reply
        .status(503)
        .send({ error: "no_snapshot", retryable: true, message: "the catalogue has not been built yet" });
    }

    const etag = `"snap-${current.snapshot.version}"`;
    reply.header("etag", etag);
    reply.header("cache-control", "no-cache");

    if (request.headers["if-none-match"] === etag) {
      return reply.status(304).send();
    }

    return {
      snapshot: {
        version: current.snapshot.version,
        refreshedAt: current.snapshot.refreshedAt,
        modelCount: current.snapshot.modelCount,
        supportedCount: current.snapshot.supportedCount
      },
      models: current.models
    };
  });

  app.get("/v1/config/use-cases", async (request, reply) => {
    if (options.authorize) {
      const installationId = await options.authorize(request);
      if (!installationId) {
        return reply.status(401).send({ error: "not_authenticated" });
      }
    }

    return { useCases: await options.useCases(), serverTime: new Date().toISOString() };
  });
}
