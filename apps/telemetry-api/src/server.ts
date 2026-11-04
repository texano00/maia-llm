import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { registerDiagnosticsRoutes } from "./diagnostics.js";
import { registerReputationRoutes } from "./reputation.js";
import { GpuReputationStore } from "./reputation-store.js";

export interface BuildServerOptions {
  /** Where GPU reputation is persisted; defaults to `MAIA_REPUTATION_FILE`. */
  reputationFile?: string;
  reputationStore?: GpuReputationStore;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.get("/health", async () => ({ status: "ok" }));
  registerDiagnosticsRoutes(app);

  const store =
    options.reputationStore ??
    new GpuReputationStore({
      filePath:
        options.reputationFile ??
        process.env.MAIA_REPUTATION_FILE ??
        resolve(process.cwd(), "var/gpu-reputation.json")
    });
  registerReputationRoutes(app, store);

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
