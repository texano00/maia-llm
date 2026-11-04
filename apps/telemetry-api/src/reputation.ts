import type { FastifyInstance } from "fastify";
import { gpuListSchema, gpuReportSchema, gpuUpsertSchema } from "./reputation-contract.js";
import type { GpuReputationStore } from "./reputation-store.js";

const machineIdSchema = (raw: unknown): number | null => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
};

/**
 * Public GPU reputation API: the shared memory of which vast.ai machines start
 * reliably. Any Maia LLM workspace reads it before renting and reports back
 * after every attempt, so a broken host costs one failure in total.
 */
export function registerReputationRoutes(app: FastifyInstance, store: GpuReputationStore): void {
  app.get("/v1/gpus", async (request) => {
    const { status, limit } = request.query as { status?: string; limit?: string };
    const parsedLimit = Math.min(Math.max(Number(limit ?? "200") || 200, 1), 1_000);

    const all = store.list();
    const filtered = status ? all.filter((record) => record.status === status) : all;

    return gpuListSchema.parse({
      gpus: filtered.slice(0, parsedLimit),
      serverTime: new Date().toISOString()
    });
  });

  app.get("/v1/gpus/:machineId", async (request, reply) => {
    const machineId = machineIdSchema((request.params as { machineId?: string }).machineId);
    if (machineId === null) {
      return reply.status(400).send({ error: "invalid_machine_id" });
    }

    const record = store.get(machineId);
    return record ? record : reply.status(404).send({ error: "unknown_machine" });
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

    const record = store.report(machineId, parsed.data);
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

    return store.upsert(machineId, parsed.data);
  });

  app.delete("/v1/gpus/:machineId", async (request, reply) => {
    const machineId = machineIdSchema((request.params as { machineId?: string }).machineId);
    if (machineId === null) {
      return reply.status(400).send({ error: "invalid_machine_id" });
    }

    return store.remove(machineId)
      ? reply.status(204).send()
      : reply.status(404).send({ error: "unknown_machine" });
  });
}
