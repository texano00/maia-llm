import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { pathToFileURL } from "node:url";
import { bearerToken } from "./auth.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createAppContext, type AppContext } from "./context.js";
import { registerDiagnosticsRoutes } from "./diagnostics.js";
import { registerFailureRoutes } from "./failures.js";
import { registerPortalAuthRoutes } from "./portal-auth-routes.js";
import { registerReputationRoutes } from "./reputation.js";

export interface BuildServerOptions {
  /** Pre-built context (tests); the server will not close it. */
  context?: AppContext;
  /** Config for the context this call creates. */
  config?: ServerConfig;
  /** Test clock used by the services. */
  now?: () => number;
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

  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.get("/health", async () => ({ status: "ok", storage: context.db.dialect }));

  const authorize = context.config.requireClientAuth
    ? async (request: FastifyRequest): Promise<string | null> => {
        const token = bearerToken(request);
        return token ? context.tokens.verifyAccess(token) : null;
      }
    : undefined;

  registerPortalAuthRoutes(app, {
    tokens: context.tokens,
    admins: context.admins,
    secureCookies: process.env.NODE_ENV === "production",
    ...(options.now ? { now: options.now } : {}),
  });

  registerDiagnosticsRoutes(app, context.telemetry, authorize ? { authorize } : {});
  registerReputationRoutes(app, context.gpus);
  registerFailureRoutes(app, context.failures, authorize ? { authorize } : {});

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

  await app.listen({ port, host });
  app.log.info(
    { storage: context.db.dialect, file: context.config.databaseFile },
    "telemetry API ready",
  );

  const shutdown = async (): Promise<void> => {
    await app.close();
    await context.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
