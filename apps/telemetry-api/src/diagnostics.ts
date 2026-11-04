import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TelemetryService } from "./services/telemetry-service.js";

const diagnosticEventSchema = z.object({
  time: z.number().int().nonnegative(),
  level: z.string().min(1).max(16),
  message: z.string().max(4_000),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const diagnosticsPayloadSchema = z.object({
  app: z.string().max(64),
  version: z.string().max(64),
  platform: z.string().max(64),
  events: z.array(diagnosticEventSchema).min(1).max(200),
});

export type DiagnosticsPayload = z.infer<typeof diagnosticsPayloadSchema>;

const MAX_BATCHES = 200;

const clampLimit = (raw: unknown, fallback: number, max = MAX_BATCHES): number => {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 1), max) : fallback;
};

const isoTimestamp = (raw: unknown): string | undefined => {
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
};

/**
 * Diagnostic sink and telemetry store used while developing and testing packaged
 * builds: batches are persisted (SQLite by default, see `db/`), echoed to stdout
 * so a desktop app running elsewhere can be watched live, and pruned once they
 * fall outside the retention window. No conversation content is expected here.
 */
export function registerDiagnosticsRoutes(app: FastifyInstance, telemetry: TelemetryService): void {
  app.post("/v1/diagnostics/logs", async (request, reply) => {
    const parsed = diagnosticsPayloadSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload" });
    }

    const { accepted } = await telemetry.ingest(parsed.data);

    for (const event of parsed.data.events) {
      if (process.env.VITEST) {
        continue;
      }

      const clock = new Date(event.time).toISOString().slice(11, 19);
      const context = event.context ? ` ${JSON.stringify(event.context)}` : "";
      process.stdout.write(
        `[diag] ${clock} ${event.level.toUpperCase().padEnd(5)} ${event.message}${context}\n`,
      );
    }

    return reply.status(202).send({ accepted });
  });

  /** Recent batches, newest first, for `curl`-driven debugging. */
  app.get("/v1/diagnostics/logs", async (request) => {
    const query = request.query as { limit?: string; level?: string; since?: string };
    const level =
      typeof query.level === "string" && query.level.length > 0 ? query.level : undefined;

    return {
      batches: await telemetry.recent({
        limit: clampLimit(query.limit, 20),
        level,
        since: isoTimestamp(query.since),
      }),
    };
  });

  app.get("/v1/diagnostics/stats", async () => ({
    events: await telemetry.countEvents(),
    serverTime: new Date().toISOString(),
  }));
}
