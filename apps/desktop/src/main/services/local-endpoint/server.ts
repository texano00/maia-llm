import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { matchesOllamaModel, ollamaModelAlias } from "@maia/contracts";
import { proxyChatCompletion, type ChatMessage, type UpstreamTarget } from "./chat";
import { InvalidOptionError, sendError, sendJson, UpstreamError } from "./errors";
import { mapOllamaOptions } from "./options";
import {
  psBody,
  showBody,
  tagsBody,
  UNKNOWN_FACTS,
  type ModelFacts
} from "./model-info";

/** What the endpoint needs to know about the session it serves. */
export interface EndpointSession {
  id: string;
  modelId: string;
  state: string;
  instanceId: number | null;
}

export interface RecordedTurn {
  sessionId: string;
  modelId: string;
  /** Client name from `X-Maia-Client` or the User-Agent, for history separation. */
  client: string;
  prompt: string;
  answer: string;
  thinking: string;
  tokens: number;
  interrupted: boolean;
}

export interface EndpointMetrics {
  requests: number;
  clients: number;
  inFlight: number;
  lastActivityAt: string | null;
}

export interface LocalEndpointServerOptions {
  /** Preferred port; the next free one is used when it is taken. */
  port: number;
  appVersion: string;
  session(): EndpointSession | null;
  /** Extends the session idle timer; every request counts as activity. */
  touch(sessionId: string): void;
  resolveUpstream(session: EndpointSession): UpstreamTarget | null;
  describe(modelId: string): ModelFacts;
  recordTurn?(turn: RecordedTurn): void;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Requests served at the same time before answering 429. */
  concurrency?: number;
  /** How many ports to try after a conflict (11434 → 11435 … 11534). */
  portAttempts?: number;
}

export interface LocalEndpointHandle {
  readonly port: number;
  readonly url: string;
  metrics(): EndpointMetrics;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Ollama management endpoints this shim deliberately does not implement. */
const NOT_SUPPORTED = [
  "/api/pull",
  "/api/push",
  "/api/create",
  "/api/copy",
  "/api/delete",
  "/api/embed",
  "/api/embeddings"
];

/**
 * Starts a loopback-only Ollama-compatible server.
 *
 * It never binds a routable interface, rejects foreign `Host`/`Origin` headers
 * (DNS-rebinding defence), and answers `503` until a session is actually serving
 * chat — assistants show that as "model not ready" instead of a timeout.
 */
export async function startLocalEndpoint(
  options: LocalEndpointServerOptions
): Promise<LocalEndpointHandle> {
  const now = options.now ?? (() => new Date());
  const concurrency = options.concurrency ?? 4;
  const portAttempts = options.portAttempts ?? 100;
  const clients = new Set<string>();
  const counters = { requests: 0, inFlight: 0, lastActivityAt: null as string | null };
  let boundPort = 0;

  const server = createServer((request, response) => {
    // A rejected request must still finish the response, or the client hangs.
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }

      options.logger?.warn("IDE endpoint request failed", {
        message: error instanceof Error ? error.message : String(error)
      });
      sendError(response, 500, "internal error while serving the request");
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isAllowedHost(request.headers.host, boundPort)) {
      sendError(response, 421, "invalid host");
      return;
    }

    if (!isAllowedOrigin(request.headers.origin, boundPort)) {
      sendError(response, 403, "origin not allowed: the endpoint is loopback-only");
      return;
    }

    const url = new URL(request.url ?? "/", `http://127.0.0.1:${boundPort}`);
    const method = request.method ?? "GET";

    if (url.pathname === "/api/version" && method === "GET") {
      sendJson(response, 200, { version: "0.6.0", maia_version: options.appVersion });
      return;
    }

    if (url.pathname === "/api/tags" && method === "GET") {
      const session = requireReadySession(response);
      if (!session) {
        return;
      }

      const facts = safeFacts(session.modelId);
      sendJson(response, 200, tagsBody(session.modelId, facts, now().toISOString()));
      return;
    }

    if (url.pathname === "/api/ps" && method === "GET") {
      const session = requireReadySession(response);
      if (!session) {
        return;
      }

      const facts = safeFacts(session.modelId);
      // The idle timer is 30 min by default; report a matching horizon.
      const expiresAt = new Date(now().getTime() + 30 * 60_000).toISOString();
      sendJson(
        response,
        200,
        psBody(session.modelId, facts, now().toISOString(), expiresAt, 0)
      );
      return;
    }

    if (url.pathname === "/api/show" && method === "POST") {
      const body = await readBody(request, response);
      if (body === null) {
        return;
      }

      const session = requireReadySession(response);
      if (!session) {
        return;
      }

      const requested = typeof body.model === "string" ? body.model : "";
      if (requested.length > 0 && !matchesOllamaModel(requested, session.modelId)) {
        sendError(response, 404, "model not found");
        return;
      }

      touch(session);
      sendJson(
        response,
        200,
        showBody(session.modelId, safeFacts(session.modelId), ollamaModelAlias(session.modelId))
      );
      return;
    }

    if (url.pathname === "/api/chat" && method === "POST") {
      await handleChat(request, response);
      return;
    }

    if (url.pathname === "/api/generate" && method === "POST") {
      await handleGenerate(request, response);
      return;
    }

    if (NOT_SUPPORTED.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))) {
      sendError(
        response,
        501,
        "not supported by Maia LLM; the model is managed by the active remote session"
      );
      return;
    }

    if (url.pathname.startsWith("/api/blobs/")) {
      sendError(response, 501, "not supported by Maia LLM; weights live on the rented GPU");
      return;
    }

    sendError(response, 404, `unknown endpoint ${url.pathname}`);
  }

  async function handleChat(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request, response);
    if (body === null) {
      return;
    }

    const session = requireReadySession(response);
    if (!session) {
      return;
    }

    const requested = typeof body.model === "string" ? body.model : "";
    if (requested.length > 0 && !matchesOllamaModel(requested, session.modelId)) {
      sendError(response, 404, "model not found");
      return;
    }

    const messages = parseMessagesSafely(body.messages);
    if (messages === null) {
      sendError(response, 400, "messages must be a non-empty array of {role, content}");
      return;
    }

    await runCompletion({
      response,
      session,
      messages,
      rawOptions: body.options,
      stream: body.stream !== false,
      flatten: (delta) => ({
        model: ollamaModelAlias(session.modelId),
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: delta.content, ...(delta.thinking ? { thinking: delta.thinking } : {}) },
        done: false
      }),
      done: (result) => ({
        model: ollamaModelAlias(session.modelId),
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: result.interrupted ? "canceled" : "stop",
        total_duration: result.durationNs,
        load_duration: 0,
        prompt_eval_count: result.promptTokens ?? 0,
        eval_count: result.tokens,
        eval_duration: result.durationNs
      })
    });
  }

  async function handleGenerate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request, response);
    if (body === null) {
      return;
    }

    const session = requireReadySession(response);
    if (!session) {
      return;
    }

    const requested = typeof body.model === "string" ? body.model : "";
    if (requested.length > 0 && !matchesOllamaModel(requested, session.modelId)) {
      sendError(response, 404, "model not found");
      return;
    }

    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (prompt.trim().length === 0) {
      sendError(response, 400, "prompt must be a non-empty string");
      return;
    }

    const messages: ChatMessage[] = [];
    if (typeof body.system === "string" && body.system.length > 0) {
      messages.push({ role: "system", content: body.system });
    }
    messages.push({ role: "user", content: prompt });

    await runCompletion({
      response,
      session,
      messages,
      rawOptions: body.options,
      stream: body.stream !== false,
      flatten: (delta) => ({
        model: ollamaModelAlias(session.modelId),
        created_at: new Date().toISOString(),
        response: delta.content,
        ...(delta.thinking ? { thinking: delta.thinking } : {}),
        done: false
      }),
      done: (result) => ({
        model: ollamaModelAlias(session.modelId),
        created_at: new Date().toISOString(),
        response: "",
        done: true,
        done_reason: result.interrupted ? "canceled" : "stop",
        total_duration: result.durationNs,
        load_duration: 0,
        prompt_eval_count: result.promptTokens ?? 0,
        eval_count: result.tokens,
        eval_duration: result.durationNs
      })
    });
  }

  interface CompletionInput {
    response: ServerResponse;
    session: EndpointSession;
    messages: ChatMessage[];
    rawOptions: unknown;
    stream: boolean;
    flatten: (delta: { content: string; thinking: string }) => Record<string, unknown>;
    done: (result: CompletionResult) => Record<string, unknown>;
  }

  interface CompletionResult {
    tokens: number;
    promptTokens: number | null;
    durationNs: number;
    interrupted: boolean;
  }

  async function runCompletion(input: CompletionInput): Promise<void> {
    if (counters.inFlight >= concurrency) {
      sendError(input.response, 429, "the model is busy; retry shortly", {
        headers: { "retry-after": "2" }
      });
      return;
    }

    const client = readClient(input.response.req.headers);
    let params: ReturnType<typeof mapOllamaOptions>;
    try {
      params = mapOllamaOptions(input.rawOptions, safeFacts(input.session.modelId).contextWindow);
    } catch (error) {
      sendError(input.response, 400, error instanceof Error ? error.message : "invalid options");
      return;
    }

    const target = options.resolveUpstream(input.session);
    if (!target) {
      sendError(input.response, 503, "model endpoint is not reachable yet", { retryable: true });
      return;
    }

    touch(input.session);
    counters.requests += 1;
    counters.inFlight += 1;
    counters.lastActivityAt = now().toISOString();
    clients.add(client);
    const startedAt = process.hrtime.bigint();

    const controller = new AbortController();
    let interrupted = false;
    input.response.on("close", () => {
      if (!input.response.writableEnded) {
        interrupted = true;
        controller.abort();
      }
    });

    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (params.ignored.length > 0) {
      headers["x-maia-ignored-options"] = params.ignored.join(",");
    }

    if (input.stream) {
      input.response.writeHead(200, {
        "content-type": "application/x-ndjson",
        ...headers
      });
      input.response.flushHeaders?.();
    }

    let answer = "";
    let thinking = "";

    try {
      const result = await proxyChatCompletion({
        target,
        modelId: input.session.modelId,
        messages: input.messages,
        params: params.params,
        signal: controller.signal,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        onThinking: (delta) => {
          thinking += delta;
          if (input.stream && !input.response.writableEnded) {
            input.response.write(`${JSON.stringify(input.flatten({ content: "", thinking: delta }))}\n`);
          }
        },
        onContent: (delta) => {
          answer += delta;
          if (input.stream && !input.response.writableEnded) {
            input.response.write(`${JSON.stringify(input.flatten({ content: delta, thinking: "" }))}\n`);
          }
        }
      });

      const durationNs = Number(process.hrtime.bigint() - startedAt);
      const final = input.done({
        tokens: result.tokens,
        promptTokens: result.promptTokens,
        durationNs,
        interrupted: false
      });

      if (input.stream) {
        if (!input.response.writableEnded) {
          input.response.end(`${JSON.stringify(final)}\n`);
        }
      } else {
        const body = { ...final, message: { role: "assistant", content: answer }, response: answer };
        sendJson(input.response, 200, body, headers);
      }

      recordTurn(input.session, client, input.messages, answer, thinking, result.tokens, false);
    } catch (error) {
      const aborted = interrupted || (error instanceof Error && error.name === "AbortError");
      const message = error instanceof UpstreamError
        ? error.message
        : aborted
          ? "request cancelled"
          : error instanceof Error
            ? error.message
            : "the model request failed";

      if (input.stream && !input.response.headersSent) {
        sendError(input.response, aborted ? 499 : 502, message);
      } else if (input.stream) {
        if (!input.response.writableEnded) {
          input.response.end(
            `${JSON.stringify({
              ...input.done({
                tokens: 0,
                promptTokens: null,
                durationNs: Number(process.hrtime.bigint() - startedAt),
                interrupted: true
              }),
              error: message
            })}\n`
          );
        }
      } else if (!input.response.headersSent) {
        sendError(input.response, aborted ? 499 : 502, message);
      }

      recordTurn(input.session, client, input.messages, answer, thinking, 0, true);
    } finally {
      counters.inFlight = Math.max(0, counters.inFlight - 1);
      counters.lastActivityAt = now().toISOString();
    }
  }

  function recordTurn(
    session: EndpointSession,
    client: string,
    messages: ChatMessage[],
    answer: string,
    thinking: string,
    tokens: number,
    interrupted: boolean
  ): void {
    options.recordTurn?.({
      sessionId: session.id,
      modelId: session.modelId,
      client,
      prompt: messages.map((message) => `${message.role}: ${message.content}`).join("\n\n"),
      answer,
      thinking,
      tokens,
      interrupted
    });
  }

  function requireReadySession(response: ServerResponse): EndpointSession | null {
    const session = options.session();

    if (!session) {
      sendError(response, 503, "no active session; start a session in Maia LLM", {
        retryable: true
      });
      return null;
    }

    if (session.state !== "active") {
      sendError(response, 503, "model not ready; provisioning is still in progress", {
        retryable: true,
        headers: { "retry-after": "5" }
      });
      return null;
    }

    return session;
  }

  function safeFacts(modelId: string): ModelFacts {
    try {
      return options.describe(modelId);
    } catch {
      return UNKNOWN_FACTS;
    }
  }

  function touch(session: EndpointSession): void {
    try {
      options.touch(session.id);
    } catch {
      // A session that ended mid-request is reported by the next call.
    }
  }

  boundPort = await listenOnFreePort(server, options.port, portAttempts);

  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    metrics: () => ({
      requests: counters.requests,
      clients: clients.size,
      inFlight: counters.inFlight,
      lastActivityAt: counters.lastActivityAt
    }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      })
  };
}

async function readBody(
  request: IncomingMessage,
  response: ServerResponse
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      sendError(response, 413, "request body is larger than 10 MB");
      return null;
    }

    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendError(response, 400, "request body must be a JSON object");
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    sendError(response, 400, "invalid JSON body");
    return null;
  }
}

function parseMessagesSafely(raw: unknown): ChatMessage[] | null {
  try {
    return parseMessages(raw);
  } catch {
    return null;
  }
}

function parseMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new InvalidOptionError("messages must be a non-empty array");
  }

  const roles = new Set(["system", "user", "assistant", "tool"]);

  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new InvalidOptionError(`messages[${index}] must be an object`);
    }

    const message = entry as { role?: unknown; content?: unknown };
    if (typeof message.role !== "string" || !roles.has(message.role)) {
      throw new InvalidOptionError(`messages[${index}].role must be system, user, assistant or tool`);
    }

    if (typeof message.content !== "string") {
      throw new InvalidOptionError(`messages[${index}].content must be a string`);
    }

    return { role: message.role as ChatMessage["role"], content: message.content };
  });
}

/** Client label used to keep IDE conversations apart in history. */
function readClient(headers: IncomingMessage["headers"]): string {
  const explicit = headers["x-maia-client"];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim().slice(0, 80);
  }

  const agent = headers["user-agent"];
  if (typeof agent === "string" && agent.trim().length > 0) {
    return agent.trim().slice(0, 80);
  }

  return "ide-client";
}

function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) {
    return false;
  }

  const normalized = host.toLowerCase();
  return (
    normalized === `127.0.0.1:${port}` ||
    normalized === `localhost:${port}` ||
    normalized === `[::1]:${port}` ||
    normalized === "127.0.0.1" ||
    normalized === "localhost"
  );
}

function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) {
    return true;
  }

  return (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}` ||
    origin === `http://[::1]:${port}`
  );
}

/** Binds the preferred port, then the next free one (11434 → 11435 …). */
async function listenOnFreePort(
  server: Server,
  preferred: number,
  attempts: number
): Promise<number> {
  let lastError: unknown = null;

  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferred + offset;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };

        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });

      const address = server.address();
      if (address && typeof address === "object") {
        return address.port;
      }

      return port;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" && code !== "EACCES") {
        throw error;
      }
    }
  }

  throw new Error(
    `no free port between ${preferred} and ${preferred + attempts - 1}${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`
  );
}
