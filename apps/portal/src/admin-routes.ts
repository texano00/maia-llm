import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SqlDatabase } from "./db/database.js";
import { createOperatorGuard } from "./operator-guard.js";
import type { SnapshotService } from "./services/catalogue/snapshot-service.js";
import { UseCaseError, type UseCaseAdminService } from "./services/catalogue/use-case-admin.js";
import type { AdminAuthService } from "./services/portal-auth.js";
import {
  InternalApiError,
  capabilitySchema,
  type InternalAccountsApi
} from "./services/internal-client.js";

const useCaseSchema = z.object({
  title: z.string().min(3).max(120),
  description: z.string().min(10).max(2_000),
  imageUrl: z.string().max(300).nullish(),
  models: z.array(z.string().min(1).max(200)).min(1).max(50),
  enabled: z.boolean().optional()
});

const useCaseUpdateSchema = useCaseSchema.extend({ version: z.number().int().positive() });
const orderSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) });
const assetSchema = z.object({
  contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  base64: z.string().min(1).max(4_000_000)
});

const capabilityChangeSchema = z
  .object({
    grant: capabilitySchema.optional(),
    revoke: capabilitySchema.optional(),
    confirm: z.boolean().optional()
  })
  .refine((value) => (value.grant === undefined) !== (value.revoke === undefined), {
    message: "Exactly one of grant or revoke is required"
  });

export interface AdminRouteOptions {
  admins: AdminAuthService;
  useCases: UseCaseAdminService;
  snapshot: SnapshotService;
  db: SqlDatabase;
  /** The product's internal API: accounts and capabilities live there. */
  internal: InternalAccountsApi;
  now?: () => number;
}

/**
 * The backoffice API.
 *
 * Everything here is administrator-only: use-case curation, the forced catalogue
 * refresh, run history and the audit trail. The one public route is the uploaded
 * use-case image, which the desktop fetches to render a scenario card.
 */
export function registerAdminRoutes(app: FastifyInstance, options: AdminRouteOptions): void {
  const now = options.now ?? (() => Date.now());
  const requireOperator = createOperatorGuard({ admins: options.admins, internal: options.internal });

  const requireAdmin = async (request: FastifyRequest): Promise<string | null> =>
    (await requireOperator(request))?.accountId ?? null;

  const unauthorized = { error: "not_authenticated" } as const;

  // Accounts and capabilities are read from the product on every request, so a
  // revoked operator loses access on the next click rather than at restart.
  app.get("/admin-api/accounts", async (request, reply) => {
    if (!(await requireAdmin(request))) {
      return reply.status(401).send(unauthorized);
    }

    const query = (request.query ?? {}) as Record<string, unknown>;
    const limit = clampNumber(query.limit, 50, 1, 200);
    const offset = clampNumber(query.offset, 0, 0, 100_000);
    const search = typeof query.query === "string" ? query.query.slice(0, 254) : undefined;

    try {
      const page = await options.internal.listAccounts({ limit, offset, ...(search ? { search } : {}) });
      return { ...page, configured: true, serverTime: new Date(now()).toISOString() };
    } catch (error) {
      const failure = describeInternalFailure(error);
      return reply
        .status(failure.status)
        .send({ error: failure.error, configured: options.internal.configured });
    }
  });

  app.post("/admin-api/accounts/:id/capabilities", async (request, reply) => {
    if (!(await requireAdmin(request))) {
      return reply.status(401).send(unauthorized);
    }

    const parsed = capabilityChangeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload" });
    }

    const accountId = (request.params as { id?: string }).id ?? "";
    try {
      const updated = await options.internal.changeCapability(accountId, {
        ...(parsed.data.grant ? { grant: parsed.data.grant } : {}),
        ...(parsed.data.revoke ? { revoke: parsed.data.revoke } : {})
      });
      return { account: updated };
    } catch (error) {
      const failure = describeInternalFailure(error);
      return reply.status(failure.status).send({ error: failure.error });
    }
  });

  const fail = (error: unknown, reply: FastifyReply) => {
    if (error instanceof UseCaseError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400;
      return reply.status(status).send({ error: error.code.toLowerCase(), message: error.message });
    }

    throw error;
  };

  app.get("/v1/admin/use-cases", async (request, reply) => {
    if (!(await requireAdmin(request))) {
      return reply.status(401).send(unauthorized);
    }

    return { useCases: await options.useCases.list(true), serverTime: new Date(now()).toISOString() };
  });

  app.post("/v1/admin/use-cases", async (request, reply) => {
    const adminId = await requireAdmin(request);
    if (!adminId) {
      return reply.status(401).send(unauthorized);
    }

    const parsed = useCaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", message: parsed.error.issues[0]?.message });
    }

    try {
      const view = await options.useCases.create(parsed.data, adminId);
      return reply.status(201).send(view);
    } catch (error) {
      return fail(error, reply);
    }
  });

  app.put("/v1/admin/use-cases/order", async (request, reply) => {
    const adminId = await requireAdmin(request);
    if (!adminId) {
      return reply.status(401).send(unauthorized);
    }

    const parsed = orderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload" });
    }

    return { useCases: await options.useCases.reorder(parsed.data.ids, adminId) };
  });

  app.put("/v1/admin/use-cases/:id", async (request, reply) => {
    const adminId = await requireAdmin(request);
    if (!adminId) {
      return reply.status(401).send(unauthorized);
    }

    const parsed = useCaseUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", message: parsed.error.issues[0]?.message });
    }

    try {
      const id = (request.params as { id?: string }).id ?? "";
      return await options.useCases.update(id, parsed.data, adminId);
    } catch (error) {
      return fail(error, reply);
    }
  });

  app.delete("/v1/admin/use-cases/:id", async (request, reply) => {
    const adminId = await requireAdmin(request);
    if (!adminId) {
      return reply.status(401).send(unauthorized);
    }

    const id = (request.params as { id?: string }).id ?? "";
    const removed = await options.useCases.remove(id, adminId);

    return removed ? reply.status(204).send() : reply.status(404).send({ error: "unknown_use_case" });
  });

  app.post("/v1/admin/assets", async (request, reply) => {
    if (!(await requireAdmin(request))) {
      return reply.status(401).send(unauthorized);
    }

    const parsed = assetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload" });
    }

    try {
      return await options.useCases.saveAsset(parsed.data);
    } catch (error) {
      return fail(error, reply);
    }
  });

  // Public: scenario cards load their image from the desktop catalogue.
  app.get("/assets/:name", async (request, reply) => {
    const name = (request.params as { name?: string }).name ?? "";
    const asset = await options.useCases.readAsset(name);

    if (!asset) {
      return reply.status(404).send({ error: "unknown_asset" });
    }

    reply.header("content-type", asset.contentType);
    reply.header("cache-control", "public, max-age=86400, immutable");
    return reply.send(asset.bytes);
  });

  app.post("/v1/admin/catalogue/refresh", async (request, reply) => {
    if (!(await requireAdmin(request))) {
      return reply.status(401).send(unauthorized);
    }

    const run = await options.snapshot.refresh("manual");
    if (run.outcome === "already-running") {
      return reply.status(409).send({ error: "refresh_in_progress" });
    }

    return reply.status(run.outcome === "success" ? 202 : 500).send(run);
  });

  app.get("/v1/admin/catalogue", async (request, reply) => {
    if (!(await requireAdmin(request))) {
      return reply.status(401).send(unauthorized);
    }

    const current = await options.snapshot.current();
    const runs = await options.snapshot.listRuns(10);

    return {
      snapshot: current?.snapshot ?? null,
      ageMinutes: current
        ? Math.max(0, Math.round((now() - Date.parse(current.snapshot.refreshedAt)) / 60_000))
        : null,
      runs,
      serverTime: new Date(now()).toISOString()
    };
  });

  app.get("/v1/admin/catalogue/runs", async (request, reply) => {
    if (!(await requireAdmin(request))) {
      return reply.status(401).send(unauthorized);
    }

    const query = (request.query ?? {}) as Record<string, unknown>;
    const raw = Number(query.limit ?? 20);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 100) : 20;

    return { runs: await options.snapshot.listRuns(limit) };
  });

  app.get("/v1/admin/audit", async (request, reply) => {
    if (!(await requireAdmin(request))) {
      return reply.status(401).send(unauthorized);
    }

    const query = (request.query ?? {}) as Record<string, unknown>;
    const raw = Number(query.limit ?? 50);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 200) : 50;

    const rows = (await options.db.query(
      `SELECT occurred_at, actor_kind, actor_id, action, target
         FROM audit_entries ORDER BY occurred_at DESC, id DESC LIMIT ?`,
      [limit]
    )) as unknown as Array<Record<string, unknown>>;

    return {
      entries: rows.map((row) => ({
        occurredAt: String(row.occurred_at),
        actorKind: String(row.actor_kind),
        actorId: row.actor_id === null ? null : String(row.actor_id),
        action: String(row.action),
        target: row.target === null ? null : String(row.target)
      }))
    };
  });
}

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), min), max) : fallback;
}

/** One translation for every internal failure the accounts view can hit. */
function describeInternalFailure(error: unknown): { status: number; error: string } {
  if (error instanceof InternalApiError) {
    if (error.status === 409) {
      return { status: 409, error: "last-operator" };
    }

    if (error.status === 404) {
      return { status: 404, error: "not_found" };
    }

    return { status: 503, error: "unavailable" };
  }

  return { status: 503, error: "unavailable" };
}
