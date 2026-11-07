import type { FastifyInstance, FastifyRequest } from "fastify";
import { failureReportSchema } from "./failure-contract.js";
import type { FailureService } from "./services/failure-service.js";

const MAX_REPORTS = 500;

function clampLimit(raw: unknown, fallback: number): number {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 1), MAX_REPORTS) : fallback;
}

/**
 * Ingest and read-back of client start-up failures.
 *
 * The desktop app posts here when a session cannot start, so the root cause of
 * an engine crash survives the instance that produced it. Authentication is
 * added by the portal work; until then the route is as open as its siblings.
 */
export interface FailureRouteOptions {
  /** Present only when ingestion requires an installation credential. */
  authorize?: (request: FastifyRequest) => Promise<string | null>;
}

export function registerFailureRoutes(
  app: FastifyInstance,
  service: FailureService,
  options: FailureRouteOptions = {}
): void {
  app.post("/v1/failures", async (request, reply) => {
    if (options.authorize) {
      const installationId = await options.authorize(request);
      if (!installationId) {
        return reply.status(401).send({ error: "not_authenticated" });
      }
    }

    const parsed = failureReportSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload" });
    }

    const id = await service.record(parsed.data);
    return reply.status(202).send({ accepted: true, id });
  });

  app.get("/v1/failures", async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const reports = await service.list(clampLimit(query.limit, 50));

    return { reports, serverTime: new Date().toISOString() };
  });
}
