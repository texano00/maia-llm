import { createServer } from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { ipcChannels, type IpcChannel } from "@maia/contracts";
import { createWebHost } from "./host";

const PORT = Number(process.env.MAIA_WEB_PORT ?? 5173);
const HOST = process.env.MAIA_WEB_HOST ?? "127.0.0.1";
const RENDERER_DIR = resolve(process.cwd(), "out/renderer");
const DATA_DIR = resolve(process.env.MAIA_WEB_DATA ?? ".maia-web");
const providerMode = process.env.MAIA_PROVIDER_MODE === "live" ? "live" : "mock";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json"
};

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const listeners = new Set<(channel: string, payload: unknown) => void>();

  // Long-lived SSE connections are buffered by some proxies (including the
  // forwarded ports used for browser testing), so events are also kept in a
  // bounded log that the client can poll with a cursor.
  const events: Array<{ id: number; channel: string; payload: unknown }> = [];
  // Seeded from the clock so cursors stay valid across host restarts.
  let nextEventId = Date.now();
  const record = (channel: string, payload: unknown): void => {
    events.push({ id: nextEventId, channel, payload });
    nextEventId += 1;
    if (events.length > 500) {
      events.splice(0, events.length - 500);
    }
  };

  const host = await createWebHost({
    databasePath: join(DATA_DIR, "maia.db"),
    providerMode,
    onEvent: (channel, payload) => {
      record(channel, payload);
      for (const listener of listeners) {
        listener(channel, payload);
      }
    }
  });

  const allowed = new Set<string>(ipcChannels);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (url.pathname === "/rpc" && request.method === "POST") {
        const body = await readJson(request);
        const channel = String(body.channel ?? "");

        if (!allowed.has(channel)) {
          sendJson(response, 400, { ok: false, error: { code: "VALIDATION_FAILED", message: `Unknown channel ${channel}` } });
          return;
        }

        const result = await host.registry.invoke(channel as IpcChannel, body.payload);
        sendJson(response, 200, result);
        return;
      }

      if (url.pathname === "/events" && request.method === "GET" && url.searchParams.has("since")) {
        const since = Number(url.searchParams.get("since") ?? "-1");
        const pending = since < 0 ? [] : events.filter((event) => event.id > since);

        sendJson(response, 200, {
          events: pending,
          lastEventId:
            pending.length > 0
              ? pending[pending.length - 1]!.id
              : Math.max(since, nextEventId - 1)
        });
        return;
      }

      if (url.pathname === "/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        response.write(": connected\n\n");

        const listener = (channel: string, payload: unknown): void => {
          response.write(`event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`);
        };
        listeners.add(listener);

        const keepAlive = setInterval(() => response.write(": ping\n\n"), 15_000);
        request.on("close", () => {
          clearInterval(keepAlive);
          listeners.delete(listener);
        });
        return;
      }

      if (url.pathname === "/health") {
        sendJson(response, 200, { ok: true, mode: providerMode });
        return;
      }

      await serveStatic(url.pathname, response);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) }
      });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[web] Maia LLM on http://${HOST}:${PORT} (${providerMode} providers)`);
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    await host.dispose();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function serveStatic(pathname: string, response: import("node:http").ServerResponse): Promise<void> {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(RENDERER_DIR, relative === "/" ? "index.html" : relative);

  try {
    const info = await stat(filePath);
    const target = info.isDirectory() ? join(filePath, "index.html") : filePath;
    const body = await readFile(target);
    response.writeHead(200, {
      "content-type": contentTypes[extname(target)] ?? "application/octet-stream",
      // A dev host must never serve a stale bundle after a rebuild.
      "cache-control": "no-store"
    });
    response.end(body);
  } catch {
    // Client-side routing: everything unknown falls back to the app shell.
    const shell = await readFile(join(RENDERER_DIR, "index.html")).catch(() => null);
    if (shell) {
      response.writeHead(200, { "content-type": contentTypes[".html"]!, "cache-control": "no-store" });
      response.end(shell);
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Renderer build missing. Run: npm run -w @maia/desktop build");
  }
}

function sendJson(response: import("node:http").ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readJson(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

void main();
