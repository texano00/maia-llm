import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { registerDiagnosticsRoutes } from "./diagnostics.js";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.get("/health", async () => ({ status: "ok" }));
  registerDiagnosticsRoutes(app);

  return app;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const app = buildServer();
  const port = Number(process.env.TELEMETRY_PORT ?? 8787);
  const host = process.env.TELEMETRY_HOST ?? "127.0.0.1";

  await app.listen({ port, host });
}
