import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { pathToFileURL } from "node:url";
import { bearerToken } from "./auth.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerAdminUi } from "./admin-ui.js";
import { registerConfigRoutes } from "./config-routes.js";
import { createAppContext, type AppContext } from "./context.js";
import { registerDiagnosticsRoutes } from "./diagnostics.js";
import { registerFailureRoutes } from "./failures.js";
import { registerUsageRoutes } from "./usage.js";
import { startCatalogueRefreshJob } from "./jobs/catalogue-refresh.js";
import { registerPortalAuthRoutes } from "./portal-auth-routes.js";
import { registerReputationRoutes } from "./reputation.js";
import type { InternalAccountsApi } from "./services/internal-client.js";

export interface BuildServerOptions {
  /** Pre-built context (tests); the server will not close it. */
  context?: AppContext;
  /** Config for the context this call creates. */
  config?: ServerConfig;
  /** Test clock used by the services. */
  now?: () => number;
  /**
   * Start the scheduled catalogue refresh. Only the real entrypoint sets this:
   * a test that builds a server must never reach for the network.
   */
  startJobs?: boolean;
  /** Overrides the built backoffice bundle location (default `public/admin`). */
  adminUiRoot?: string;
  /** Fake product API for tests; the real one comes from the context. */
  internal?: InternalAccountsApi;
}

/**
 * Builds the HTTP surface: telemetry ingestion plus the public GPU reputation
 * API. Storage comes from the context, so swapping SQLite for another database
 * never touches this file.
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const ownsContext = options.context === undefined;
  const context =
    options.context ??
    (await createAppContext({
      config: options.config ?? loadConfig(),
      ...(options.now ? { now: options.now } : {}),
    }));
  // Operators, accounts and capabilities all live in the product; the portal only
  // holds a session that points at one of them.
  const internal = options.internal ?? context.internal;
  const app = Fastify({    logger: process.env.NODE_ENV !== "test",
    // Behind nginx (or Caddy) the socket peer is the proxy itself; without this
    // every request in the log comes from 127.0.0.1. Set MAIA_TRUST_PROXY=false
    // only when the port is reachable without a proxy in front of it.
    trustProxy: process.env.MAIA_TRUST_PROXY !== "false",
  });

  app.get("/health", async () => ({ status: "ok", storage: context.db.dialect }));

  if (context.config.retiredAdminPasswordSet) {
    // Say it out loud: a deployment that still carries the old secret should hear
    // that it is ignored, not discover it by wondering why the password fails.
    app.log.warn(
      "MAIA_ADMIN_PASSWORD is set but ignored: operators sign in with an emailed code and their `operator` capability."
    );
  }

  const authorize = context.config.requireClientAuth
    ? async (request: FastifyRequest): Promise<string | null> => {
        const token = bearerToken(request);
        return token ? context.tokens.verifyAccess(token) : null;
      }    : undefined;

  registerPortalAuthRoutes(app, {
    tokens: context.tokens,
    admins: context.admins,
    internal,
    secureCookies: process.env.NODE_ENV === "production",
    ...(options.now ? { now: options.now } : {}),
  });

  registerDiagnosticsRoutes(app, context.telemetry, authorize ? { authorize } : {});
  registerReputationRoutes(app, context.gpus);
  registerFailureRoutes(app, context.failures, authorize ? { authorize } : {});
  if (context.config.usageEnabled) {
    registerUsageRoutes(app, context.usage, authorize ? { authorize } : {});
  }
  registerConfigRoutes(app, {
    snapshot: context.snapshot,
    useCases: context.useCases,
    ...(authorize ? { authorize } : {})
  });
  registerAdminRoutes(app, {
    admins: context.admins,
    useCases: context.useCaseAdmin,
    snapshot: context.snapshot,
    db: context.db,
    internal,
    ...(options.now ? { now: options.now } : {})
  });
  registerAdminUi(app, options.adminUiRoot ? { root: options.adminUiRoot } : {});

  if (ownsContext && options.startJobs) {
    const job = startCatalogueRefreshJob({
      service: context.snapshot,
      intervalMs: context.config.catalogueRefreshHours * 60 * 60_000
    });
    app.addHook("onClose", async () => job.stop());
  }

  if (ownsContext) {
    // Only close what this call opened.
    app.addHook("onClose", async () => {
      await context.close();
    });
  }

  return app;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const context = await createAppContext({ config: loadConfig() });
  const app = await buildServer({ context });
  const port = Number(process.env.TELEMETRY_PORT ?? 8787);
  const host = process.env.TELEMETRY_HOST ?? "127.0.0.1";

  // The snapshot is built by this process only; tests never start it.
  const catalogueJob = startCatalogueRefreshJob({
    service: context.snapshot,
    intervalMs: context.config.catalogueRefreshHours * 60 * 60_000
  });

  await app.listen({ port, host });
  app.log.info(
    { storage: context.db.dialect, file: context.config.databaseFile },
    "telemetry API ready",
  );

  const shutdown = async (): Promise<void> => {
    catalogueJob.stop();
    await app.close();
    await context.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
