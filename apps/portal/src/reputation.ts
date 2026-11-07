import type { FastifyInstance } from "fastify";
import {
  gpuListSchema,
  gpuReportSchema,
  gpuStatusSchema,
  gpuUpsertSchema,
} from "./reputation-contract.js";
import type { GpuReputationService } from "./services/gpu-reputation-service.js";

const machineIdSchema = (raw: unknown): number | null => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
};

const limitSchema = (raw: unknown, fallback: number, max = 1_000): number => {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 1), max) : fallback;
};

/**
 * Public GPU reputation API: the shared memory of which vast.ai machines start
 * reliably. Any Maia LLM workspace reads it before renting and reports back
 * after every attempt, so a broken host costs one failure in total.
 */
export function registerReputationRoutes(
  app: FastifyInstance,
  reputation: GpuReputationService,
): void {
  app.get("/v1/gpus", async (request) => {
    const { status, limit } = request.query as { status?: string; limit?: string };
    const parsedStatus = status ? gpuStatusSchema.safeParse(status) : null;

    return gpuListSchema.parse({
      gpus: await reputation.list(
        limitSchema(limit, 200),
        parsedStatus?.success ? parsedStatus.data : undefined,
      ),
      serverTime: new Date().toISOString(),
    });
  });

  app.get("/v1/gpus/:machineId", async (request, reply) => {
    const machineId = machineIdSchema((request.params as { machineId?: string }).machineId);
    if (machineId === null) {
      return reply.status(400).send({ error: "invalid_machine_id" });
    }

    const record = await reputation.get(machineId);
    return record ? record : reply.status(404).send({ error: "unknown_machine" });
  });

  /**
   * Provisioning attempts seen for one machine, newest first. Useful when
   * deciding whether a host deserves a second chance, and as the raw material
   * for tuning the unstable-verdict policy.
   */
  app.get("/v1/gpus/:machineId/reports", async (request, reply) => {
    const machineId = machineIdSchema((request.params as { machineId?: string }).machineId);
    if (machineId === null) {
      return reply.status(400).send({ error: "invalid_machine_id" });
    }

    const { limit } = request.query as { limit?: string };
    const reports = await reputation.history(machineId, limitSchema(limit, 50));

    return reply.status(200).send({
      machineId,
      reports,
      serverTime: new Date().toISOString(),
    });
  });

  /**
   * Records one provisioning outcome. Reporting is idempotent per call: the
   * server owns the counters and the freshness rule.
   */
  app.post("/v1/gpus/:machineId/reports", async (request, reply) => {
    const machineId = machineIdSchema((request.params as { machineId?: string }).machineId);
    if (machineId === null) {
      return reply.status(400).send({ error: "invalid_machine_id" });
    }

    const parsed = gpuReportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload" });
    }

    const record = await reputation.report(machineId, parsed.data);
    return reply.status(202).send(record);
  });

  /** Manual override, for example to clear a machine flagged by mistake. */
  app.put("/v1/gpus/:machineId", async (request, reply) => {
    const machineId = machineIdSchema((request.params as { machineId?: string }).machineId);
    if (machineId === null) {
      return reply.status(400).send({ error: "invalid_machine_id" });
    }

    const parsed = gpuUpsertSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload" });
    }

    return reputation.upsert(machineId, parsed.data);
  });

  app.delete("/v1/gpus/:machineId", async (request, reply) => {
    const machineId = machineIdSchema((request.params as { machineId?: string }).machineId);
    if (machineId === null) {
      return reply.status(400).send({ error: "invalid_machine_id" });
    }

    return (await reputation.remove(machineId))
      ? reply.status(204).send()
      : reply.status(404).send({ error: "unknown_machine" });
  });
}
