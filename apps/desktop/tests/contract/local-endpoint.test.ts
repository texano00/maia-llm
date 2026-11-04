import { afterEach, describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  startLocalEndpoint,
  type EndpointSession,
  type LocalEndpointHandle,
  type RecordedTurn
} from "../../src/main/services/local-endpoint/server";
import {
  formatParameterSize,
  modelDigest,
  UNKNOWN_FACTS
} from "../../src/main/services/local-endpoint/model-info";

const SESSION: EndpointSession = {
  id: "session-1",
  modelId: "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF",
  state: "active",
  instanceId: 42
};

interface Upstream {
  port: number;
  close(): Promise<void>;
  lastBody(): Record<string, unknown> | null;
}

async function startUpstream(
  responder: (response: ServerResponse, body: Record<string, unknown>) => void
): Promise<Upstream> {
  let last: Record<string, unknown> | null = null;

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += String(chunk);
    });
    request.on("end", () => {
      last = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : null;
      responder(response, last ?? {});
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    lastBody: () => last,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function streamCompletion(response: ServerResponse, content: string[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const delta of content) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
  }
  response.write(
    `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 3, prompt_tokens: 11 } })}\n\n`
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

const handles: LocalEndpointHandle[] = [];
const upstreams: Upstream[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
});

async function endpoint(options: {
  upstream: Upstream;
  session?: EndpointSession | null;
  record?: (turn: RecordedTurn) => void;
  touch?: (sessionId: string) => void;
  port?: number;
}) {
  const recorded: RecordedTurn[] = [];
  const touched: string[] = [];

  const handle = await startLocalEndpoint({
    port: options.port ?? 0,
    appVersion: "0.7.0",
    session: () => (options.session === undefined ? SESSION : options.session),
    touch: (sessionId) => {
      touched.push(sessionId);
      options.touch?.(sessionId);
    },
    resolveUpstream: () => ({ host: "127.0.0.1", port: options.upstream.port }),
    describe: () => UNKNOWN_FACTS,
    recordTurn: (turn) => {
      recorded.push(turn);
      options.record?.(turn);
    }
  });

  handles.push(handle);
  return { handle, recorded, touched, url: handle.url };
}

describe("IDE endpoint: Ollama surface", () => {
  it("reports its version, the single model, and its details", async () => {
    const upstream = await startUpstream((response) => response.end("{}"));
    upstreams.push(upstream);
    const { url } = await endpoint({ upstream });

    const version = await (await fetch(`${url}/api/version`)).json();
    expect(version).toMatchObject({ version: "0.6.0", maia_version: "0.7.0" });

    const tags = await (await fetch(`${url}/api/tags`)).json();
    expect(tags.models).toHaveLength(1);
    expect(tags.models[0]).toMatchObject({
      name: `${SESSION.modelId}:latest`,
      model: `${SESSION.modelId}:latest`,
      digest: modelDigest(SESSION.modelId)
    });

    const ps = await (await fetch(`${url}/api/ps`)).json();
    expect(ps.models[0]).toHaveProperty("expires_at");

    const show = await (
      await fetch(`${url}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF" })
      })
    ).json();
    expect(show.capabilities).toEqual(["completion"]);

    // An unknown model is a 404, not a silent fallback to the active one.
    const missing = await fetch(`${url}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "someone/else" })
    });
    expect(missing.status).toBe(404);
  });

  it("streams chat as NDJSON and records the turn for history", async () => {
    const upstream = await startUpstream((response) => streamCompletion(response, ["Hello", " world"]));
    upstreams.push(upstream);
    const { url, recorded, touched } = await endpoint({ upstream });

    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-maia-client": "continue" },
      body: JSON.stringify({
        model: `${SESSION.modelId}:latest`,
        messages: [{ role: "user", content: "hi" }],
        options: { temperature: 0.2, num_predict: 64 }
      })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");

    const lines = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const deltas = lines.filter((line) => line.done === false);
    expect(deltas.map((line) => (line.message as { content: string }).content).join("")).toBe(
      "Hello world"
    );

    const final = lines.at(-1);
    expect(final).toMatchObject({
      done: true,
      done_reason: "stop",
      eval_count: 3,
      prompt_eval_count: 11
    });

    // Options reach vLLM as OpenAI parameters, not Ollama names.
    expect(upstream.lastBody()).toMatchObject({ temperature: 0.2, max_tokens: 64, stream: true });

    // Every request counts as activity so the idle timer does not release a GPU
    // while an editor is using it.
    expect(touched).toContain(SESSION.id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      client: "continue",
      answer: "Hello world",
      tokens: 3,
      interrupted: false
    });
  });

  it("supports non-streaming chat and /api/generate", async () => {
    const upstream = await startUpstream((response) => streamCompletion(response, ["Done"]));
    upstreams.push(upstream);
    const { url } = await endpoint({ upstream });

    const chat = await (
      await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: SESSION.modelId,
          stream: false,
          messages: [{ role: "user", content: "hi" }]
        })
      })
    ).json();
    expect(chat.done).toBe(true);
    expect(chat.message).toEqual({ role: "assistant", content: "Done" });

    const generate = await (
      await fetch(`${url}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: SESSION.modelId, prompt: "hi", stream: false })
      })
    ).json();
    expect(generate.response).toBe("Done");
  });

  it("answers 503 while there is no session and while it boots", async () => {
    const upstream = await startUpstream((response) => response.end("{}"));
    upstreams.push(upstream);

    const none = await endpoint({ upstream, session: null });
    const noSession = await fetch(`${none.url}/api/tags`);
    expect(noSession.status).toBe(503);
    expect(await noSession.json()).toMatchObject({ error: expect.stringMatching(/no active session/) });

    const booting = await endpoint({ upstream, session: { ...SESSION, state: "provisioning" } });
    const notReady = await fetch(`${booting.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
    });
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toMatchObject({ retryable: true });
  });

  it("rejects invalid options, foreign hosts, and management endpoints", async () => {
    const upstream = await startUpstream((response) => response.end("{}"));
    upstreams.push(upstream);
    const { url, handle } = await endpoint({ upstream });

    const invalid = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], options: { temperature: "hot" } })
    });
    expect(invalid.status).toBe(400);

    // DNS rebinding: a request that claims another host must never be served.
    const rebound = await rawRequest({
      port: handle.port,
      path: "/api/version",
      host: `evil.example:${handle.port}`
    });
    expect(rebound.status).toBe(421);

    const pull = await fetch(`${url}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" })
    });
    expect(pull.status).toBe(501);
    expect(await pull.json()).toMatchObject({ error: expect.stringMatching(/not supported/) });
  });

  it("falls back to the next free port when the preferred one is taken", async () => {
    const upstream = await startUpstream((response) => response.end("{}"));
    upstreams.push(upstream);
    const first = await endpoint({ upstream });
    const second = await endpoint({ upstream, port: first.handle.port });

    expect(second.handle.port).toBe(first.handle.port + 1);
    expect(second.handle.url).toBe(`http://127.0.0.1:${second.handle.port}`);
  });
});

describe("IDE endpoint: option mapping", () => {
  it("formats parameter sizes for the model details", () => {
    expect(formatParameterSize(27_320_697_856)).toBe("27.3B");
    expect(formatParameterSize(3_212_749_888)).toBe("3.2B");
    expect(formatParameterSize(124_439_808)).toBe("124M");
    expect(formatParameterSize(null)).toBe("unknown");
  });
});

function rawRequest(options: {
  port: number;
  path: string;
  host: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: options.port,
        path: options.path,
        method: "GET",
        headers: { host: options.host }
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += String(chunk);
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      }
    );

    request.on("error", reject);
    request.end();
  });
}
