import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp"
};

const MISSING_BUILD = `<!doctype html>
<html><head><meta charset="utf-8"><title>Maia LLM backoffice</title></head>
<body style="font:16px system-ui;background:#070a12;color:#e7ecf5;padding:3rem">
  <h1>Backoffice not built</h1>
  <p>Run <code>npm run -w @maia/telemetry-api build:admin</code> and reload.</p>
</body></html>`;

/**
 * Serves the built backoffice bundle at `/admin`.
 *
 * Same origin as the API on purpose: the admin session cookie is `SameSite=Strict`
 * and `HttpOnly`, so the SPA never needs CORS or a token in JavaScript.
 */
export function registerAdminUi(app: FastifyInstance, options: { root?: string } = {}): void {
  const root = resolve(options.root ?? join(process.cwd(), "public/admin"));

  async function sendFile(reply: FastifyReply, file: string) {
    try {
      const body = await readFile(file);
      reply.header("content-type", CONTENT_TYPES[extname(file)] ?? "application/octet-stream");
      reply.header("cache-control", file.endsWith("index.html") ? "no-cache" : "public, max-age=3600");
      return reply.send(body);
    } catch {
      return reply.status(200).type("text/html; charset=utf-8").send(MISSING_BUILD);
    }
  }

  app.get("/admin", async (_request, reply) => sendFile(reply, join(root, "index.html")));

  app.get("/admin/*", async (request, reply) => {
    const relative = (request.params as { "*"?: string })["*"] ?? "";
    const candidate = normalize(join(root, relative));

    // Path traversal guard: only files under the build root are reachable.
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      return reply.status(404).send({ error: "not_found" });
    }

    const exists = await stat(candidate)
      .then((entry) => entry.isFile())
      .catch(() => false);

    // Unknown paths without an extension are client-side routes: serve the shell.
    if (!exists && extname(relative).length > 0) {
      return reply.status(404).send({ error: "not_found" });
    }

    return sendFile(reply, exists ? candidate : join(root, "index.html"));
  });
}
