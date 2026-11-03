import type { FastifyInstance } from "fastify";
import { z } from "zod";

const diagnosticEventSchema = z.object({
  time: z.number().int().nonnegative(),
  level: z.string().min(1).max(16),
  message: z.string().max(4_000),
  context: z.record(z.string(), z.unknown()).optional()
});

export const diagnosticsPayloadSchema = z.object({
  app: z.string().max(64),
  version: z.string().max(64),
  platform: z.string().max(64),
  events: z.array(diagnosticEventSchema).min(1).max(200)
});

export type DiagnosticsPayload = z.infer<typeof diagnosticsPayloadSchema>;

const MAX_RETAINED_EVENTS = 1_000;

/**
 * Diagnostic sink used while developing and testing packaged builds: it keeps
 * the most recent log lines in memory and echoes them to stdout so a desktop app
 * running on another machine can be watched live. Nothing is persisted and no
 * conversation content is expected here; T108+ replaces it with the consented
 * telemetry ingestion contract.
 */
export function registerDiagnosticsRoutes(app: FastifyInstance): void {
  const retained: Array<DiagnosticsPayload & { receivedAt: string }> = [];

  app.post("/v1/diagnostics/logs", async (request, reply) => {
    const parsed = diagnosticsPayloadSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload" });
    }

    retained.push({ ...parsed.data, receivedAt: new Date().toISOString() });
    if (retained.length > MAX_RETAINED_EVENTS) {
      retained.splice(0, retained.length - MAX_RETAINED_EVENTS);
    }

    for (const event of parsed.data.events) {
      if (process.env.VITEST) {
        continue;
      }

      const clock = new Date(event.time).toISOString().slice(11, 19);
      const context = event.context ? ` ${JSON.stringify(event.context)}` : "";
      process.stdout.write(
        `[diag] ${clock} ${event.level.toUpperCase().padEnd(5)} ${event.message}${context}\n`
      );
    }

    return reply.status(202).send({ accepted: parsed.data.events.length });
  });

  app.get("/v1/diagnostics/logs", async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? "200");
    const safeLimit = Number.isFinite(limit)
      ? Math.min(Math.max(limit, 1), MAX_RETAINED_EVENTS)
      : 200;

    return { events: retained.slice(-safeLimit) };
  });
}

