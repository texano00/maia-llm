import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fail, ipcChannels, type AuthState, type IpcChannel, type Result } from "@maia/contracts";
import { createWebPlatform, publicChannels, type WebPlatform } from "./host";
import type { IpcRegistry, IpcInvokeContext } from "../main/ipc/registry";
import { clearedSessionCookie, maxAgeSeconds, parseCookie, sessionCookie } from "./cookies";
import { appearanceCookie } from "./preferences";
import { createInternalRoutes } from "./internal";

const PORT = Number(process.env.MAIA_WEB_PORT ?? 5173);
const HOST = process.env.MAIA_WEB_HOST ?? "127.0.0.1";
const RENDERER_DIR = resolve(process.cwd(), "out/renderer");
const DATA_DIR = resolve(process.env.MAIA_WEB_DATA ?? ".maia-web");
// Live is the default. Defaulting to the simulated provider meant a deployment
// that simply forgot the variable showed a fake $25 wallet and simulated every
// rental while telling people they were renting GPUs. Simulation is now opt-in,
// and a live deployment without a key is refused rather than faked.
const providerMode = process.env.MAIA_PROVIDER_MODE?.trim().toLowerCase() === "mock" ? "mock" : "live";
const secureCookies = process.env.MAIA_COOKIE_SECURE !== "false";
const trustProxy = process.env.MAIA_TRUST_PROXY?.trim().toLowerCase() ?? "";
const publicOrigin = process.env.MAIA_PUBLIC_ORIGIN?.trim() || null;

/** Reads a bounded minute value from the environment, falling back quietly. */
function minutesFrom(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value?.trim());
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

const bootCeilingMinutes = minutesFrom(process.env.MAIA_BOOT_CEILING_MINUTES, 60, 5, 240);
const bootQuietMinutes = minutesFrom(process.env.MAIA_BOOT_QUIET_MINUTES, 15, 5, 120);
const bootReminderMinutes = minutesFrom(process.env.MAIA_BOOT_REMINDER_MINUTES, 10, 1, 60);

/** Four 20 MB images, base64 encoded, inside one `chat.send`. */
const MAX_BODY_BYTES = 128 * 1024 * 1024;

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

interface FeedEvent {
  id: number;
  accountId: string;
  channel: string;
  payload: unknown;
}

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });

  // Events are kept in a bounded log so the client can poll with a cursor:
  // long-lived SSE connections are buffered by some proxies.
  const events: FeedEvent[] = [];
  // Seeded from the clock so cursors stay valid across host restarts.
  let nextEventId = Date.now();
  const listeners = new Map<string, Set<(channel: string, payload: unknown) => void>>();

  const record = (accountId: string, channel: string, payload: unknown): void => {
    events.push({ id: nextEventId, accountId, channel, payload });
    nextEventId += 1;
    if (events.length > 2_000) {
      events.splice(0, events.length - 2_000);
    }

    for (const listener of listeners.get(accountId) ?? []) {
      listener(channel, payload);
    }
  };

  const platform = await createWebPlatform({
    databasePath: join(DATA_DIR, "maia.db"),
    providerMode,
    bootCeilingMinutes,
    bootQuietMinutes,
    bootReminderMinutes,
    onEvent: record
  });

  const allowed = new Set<string>(ipcChannels);

  // Absent token: nothing is mounted, so every `/internal/*` path is a 404.
  const internal = createInternalRoutes({
    platform,
    token: process.env.MAIA_INTERNAL_TOKEN?.trim() || null
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      // A browser request carries an Origin; a different one is an attempt to
      // drive this session from another site.
      if (!originAllowed(request)) {
        response.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end("Cross-origin request refused");
        return;
      }

      if (url.pathname === "/rpc" && request.method === "POST") {
        await handleRpc(platform, request, response, allowed);
        return;
      }

      if (url.pathname === "/events") {
        await handleEvents(platform, request, response, url, events, nextEventId, listeners);
        return;
      }

      if (url.pathname === "/health") {
        // The backoffice reads this to show which product build it administers.
        sendJson(response, 200, {
          ok: true,
          mode: providerMode,
          version: platform.version
        });
        return;
      }

      if (internal && (await internal.handle(request, response, url))) {
        return;
      }

      await serveStatic(url.pathname, response);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: {
          code: "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
          retryable: false
        }
      });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[web] Maia LLM on http://${HOST}:${PORT} (${providerMode} providers)`);
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    await platform.dispose();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function handleRpc(
  platform: WebPlatform,
  request: IncomingMessage,
  response: ServerResponse,
  allowed: Set<string>
): Promise<void> {
  const body = await readJson(request);
  const channel = String(body.channel ?? "");

  if (!allowed.has(channel)) {
    sendJson(response, 400, fail("VALIDATION_FAILED", `Unknown channel ${channel}`));
    return;
  }

  const token = parseCookie(request.headers.cookie);
  const headers: Record<string, string> = { "cache-control": "no-store" };
  const typed = channel as IpcChannel;
  let registry: IpcRegistry;
  let accountId: string | null = null;

  if (publicChannels.has(typed)) {
    registry = platform.publicRegistry;
  } else {
    accountId = platform.access.accountFor(token);
    if (!accountId) {
      // 200 with a typed error: the renderer switches to the access page
      // instead of treating a session expiry as a transport failure.
      sendJson(response, 200, fail("NOT_AUTHENTICATED", "Sign in to continue."), headers);
      return;
    }

    registry = (await platform.accounts.get(accountId)).registry;
  }

  const result = await invokeWithDeadline(registry, typed, body.payload, {
    sessionToken: token,
    sourceAddress: clientAddress(request),
    userAgent: request.headers["user-agent"] ?? null,
    setSessionCookie: (value, expiresAt) => {
      headers["set-cookie"] = sessionCookie(value, maxAgeSeconds(expiresAt), secureCookies);
    },
    clearSessionCookie: () => {
      headers["set-cookie"] = clearedSessionCookie(secureCookies);
    },
    setAppearance: (value) => {
      headers["set-cookie"] = appearanceCookie(value, secureCookies);
    }
  }, typed);

  if (result === TIMED_OUT) {
    // Cloudflare gives up at ~100 s and shows its own error page. Answering here
    // with a typed, retryable error keeps the product in charge of its own
    // failure, and the catalogue serves what it already has.
    sendJson(
      response,
      200,
      fail(
        "PROVIDER_UNAVAILABLE",
        typed.startsWith("catalogue")
          ? "The catalogue is taking longer than usual. Showing what is already loaded; try again in a moment."
          : "This is taking longer than expected. Try again in a moment.",
        true
      ),
      headers
    );
    return;
  }

  // The signed-in account's stored appearance seeds the cookie a new browser
  // reads before its first paint.
  if (typed === "auth.state" && result.ok) {
    const state = result.data as AuthState;
    if (state.signedIn) {
      headers["set-cookie"] = appearanceCookie(state.appearance, secureCookies);
    }
  }

  if (result.ok && typed === "auth.deleteAccount" && accountId) {
    platform.accounts.evict(accountId);
  }

  sendJson(response, 200, result, headers);
}

async function handleEvents(
  platform: WebPlatform,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  events: FeedEvent[],
  nextEventId: number,
  listeners: Map<string, Set<(channel: string, payload: unknown) => void>>
): Promise<void> {
  const token = parseCookie(request.headers.cookie);
  const accountId = platform.access.accountFor(token);

  if (url.searchParams.has("since")) {
    const since = Number(url.searchParams.get("since") ?? "-1");
    const pending =
      accountId && since >= 0
        ? events.filter((event) => event.accountId === accountId && event.id > since)
        : [];

    sendJson(
      response,
      200,
      {
        events: pending,
        lastEventId:
          pending.length > 0 ? pending[pending.length - 1]!.id : Math.max(since, nextEventId - 1)
      },
      { "cache-control": "no-store" }
    );
    return;
  }

  if (!accountId) {
    response.writeHead(401, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end("Sign in to receive events");
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive"
  });
  response.write(": connected\n\n");

  const listener = (channel: string, payload: unknown): void => {
    response.write(`event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const bucket = listeners.get(accountId) ?? new Set();
  bucket.add(listener);
  listeners.set(accountId, bucket);

  const keepAlive = setInterval(() => response.write(": ping\n\n"), 15_000);
  request.on("close", () => {
    clearInterval(keepAlive);
    bucket.delete(listener);
    if (bucket.size === 0) {
      listeners.delete(accountId);
    }
  });
}

function originAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) {
    // Not a browser fetch (curl, health check, proxy); the cookie check still
    // applies, and a cross-site page cannot omit Origin.
    return true;
  }

  const host = request.headers.host ?? "";
  const candidates = new Set([`http://${host}`, `https://${host}`]);
  if (publicOrigin) {
    candidates.add(publicOrigin.replace(/\/$/, ""));
  }

  return candidates.has(origin.replace(/\/$/, ""));
}

/** `CF-Connecting-IP` only when the proxy is explicitly trusted. */
function clientAddress(request: IncomingMessage): string {
  if (trustProxy === "cloudflare") {
    const header = request.headers["cf-connecting-ip"];
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return request.socket.remoteAddress ?? "unknown";
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(RENDERER_DIR, relative === "/" ? "index.html" : relative);

  try {
    const info = await stat(filePath);
    const target = info.isDirectory() ? join(filePath, "index.html") : filePath;
    const body = await readFile(target);
    response.writeHead(200, {
      "content-type": contentTypes[extname(target)] ?? "application/octet-stream",
      // A deployment must never serve a stale bundle after a rebuild.
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
    response.end("Renderer build missing. Run: npm run -w @maia/web build");
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: Result<unknown> | Record<string, unknown>,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    total += (chunk as Buffer).byteLength;
    if (total > MAX_BODY_BYTES) {
      throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    }

    chunks.push(chunk as Buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

/**
 * How long one channel may run before the host answers on its behalf.
 *
 * Cloudflare gives up at ~100 s and shows its own error page, which is how a slow
 * Hugging Face search became a 504 instead of a product message. A deadline here
 * keeps the origin responsive and lets the catalogue serve what it already has;
 * the underlying work is bounded by its own provider timeouts.
 */
const RPC_BUDGET_MS: Record<string, number> = {
  "catalogue.search": 12_000,
  "catalogue.refresh": 20_000,
  "catalogue.detail": 15_000
};
const DEFAULT_RPC_BUDGET_MS = 30_000;

const TIMED_OUT = Symbol("rpc-timed-out");

async function invokeWithDeadline(
  registry: IpcRegistry,
  channel: IpcChannel,
  payload: unknown,
  context: IpcInvokeContext,
  typed: IpcChannel
): Promise<Result<unknown> | typeof TIMED_OUT> {
  const budget = RPC_BUDGET_MS[typed] ?? DEFAULT_RPC_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), budget);
    timer.unref?.();
  });

  try {
    return await Promise.race([registry.invoke(typed, payload, context), deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

void main();
