import { createServer, request as httpRequest, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalEndpoint, type LocalEndpointHandle } from "../../src/main/services/local-endpoint/server";

const MODEL_ID = "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF";

/** A llama.cpp-shaped upstream: SSE deltas with reasoning, then content. */
function fakeUpstream(): Server {
  return createServer((request, response) => {
    if (!request.url?.startsWith("/v1/chat/completions")) {
      response.writeHead(404).end();
      return;
    }

    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const payload = JSON.parse(body || "{}") as { stream?: boolean };
      const answer = "hello from the fake upstream";

      if (payload.stream === false) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: answer }, finish_reason: "stop" }],
            usage: { prompt_tokens: 9, completion_tokens: 5 }
          })
        );
        return;
      }

      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hmm" } }] })}\n\n`);
      for (const word of answer.split(" ")) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${word} ` } }] })}\n\n`);
      }
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
}

function post(port: number, path: string, body: unknown): Promise<{ status: number; json: () => unknown; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text,
            json: () => JSON.parse(text) as unknown
          })
        );
      }
    );
    request.on("error", reject);
    request.end(payload);
  });
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (response) => {
      let text = "";
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("local IDE endpoint", () => {
  let upstream: Server;
  let upstreamPort = 0;
  let ready: LocalEndpointHandle;
  let idle: LocalEndpointHandle;

  const start = (withSession: boolean) =>
    startLocalEndpoint({
      port: 0,
      portAttempts: 1,
      appVersion: "test",
      concurrency: 4,
      session: () => (withSession ? { id: "s1", modelId: MODEL_ID, state: "active", instanceId: 1 } : null),
      touch: () => undefined,
      resolveUpstream: () => ({ host: "127.0.0.1", port: upstreamPort }),
      describe: () => ({
        parameterCount: 27_320_697_856,
        contextWindow: 32_768,
        license: null,
        architecture: "qwen3",
        format: "gguf"
      })
    });

  beforeAll(async () => {
    upstream = fakeUpstream();
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    upstreamPort = (upstream.address() as { port: number }).port;
    ready = await start(true);
    idle = await start(false);
  });

  afterAll(async () => {
    await ready.close();
    await idle.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("answers /api/version without a session", async () => {
    const response = await get(ready.port, "/api/version");

    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ version: "0.6.0", maia_version: "test" });
  });

  it("lists the running model under its Ollama alias", async () => {
    const response = await get(ready.port, "/api/tags");
    const body = JSON.parse(response.text) as { models: Array<{ name: string; details: { format: string } }> };

    expect(body.models[0]?.name).toBe(`${MODEL_ID}:latest`);
    expect(body.models[0]?.details.format).toBe("gguf");
  });

  it("answers /api/chat with a message and no generate-only field", async () => {
    const response = await post(ready.port, "/api/chat", {
      model: MODEL_ID,
      stream: false,
      messages: [{ role: "user", content: "hi" }]
    });
    const body = response.json() as {
      message: { role: string; content: string; thinking?: string };
      response?: string;
      done: boolean;
    };

    expect(response.status).toBe(200);
    expect(body.done).toBe(true);
    expect(body.message.content).toBe("hello from the fake upstream ");
    // A thinking model carries its reasoning next to the answer…
    expect(body.message.thinking).toBe("hmm");
    // …and `/api/chat` never grows `/api/generate`'s `response` field, which
    // strict clients read as the answer and find empty.
    expect(body.response).toBeUndefined();
  });

  it("answers /api/generate with a response and no message", async () => {
    const response = await post(ready.port, "/api/generate", { model: MODEL_ID, prompt: "hi", stream: false });
    const body = response.json() as { response: string; message?: unknown; thinking?: string };

    expect(body.response).toBe("hello from the fake upstream ");
    expect(body.message).toBeUndefined();
    expect(body.thinking).toBe("hmm");
  });

  it("streams NDJSON chunks", async () => {
    const response = await post(ready.port, "/api/chat", {
      model: MODEL_ID,
      messages: [{ role: "user", content: "hi" }]
    });

    const lines = response.text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { done: boolean; message?: { content: string; thinking?: string } });

    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]?.message?.thinking).toBe("hmm");
    expect(lines.at(-1)?.done).toBe(true);
  });

  it("rejects an unknown model, invalid options and body", async () => {
    const wrongModel = await post(ready.port, "/api/chat", {
      model: "nope/model",
      messages: [{ role: "user", content: "hi" }]
    });
    const badOption = await post(ready.port, "/api/chat", {
      model: MODEL_ID,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
      options: { temperature: "hot" }
    });
    const emptyMessages = await post(ready.port, "/api/chat", { model: MODEL_ID, messages: [] });

    expect(wrongModel.status).toBe(404);
    expect(badOption.status).toBe(400);
    expect(badOption.text).toContain("temperature");
    expect(emptyMessages.status).toBe(400);
  });

  it("refuses Ollama's download endpoints and foreign hosts", async () => {
    const pull = await post(ready.port, "/api/pull", { model: MODEL_ID });
    const foreign = await get(ready.port, "/api/version", { host: "evil.example" });

    expect(pull.status).toBe(501);
    expect(foreign.status).toBe(421);
  });

  it("answers 503 while no session is running", async () => {
    const response = await post(idle.port, "/api/chat", {
      model: MODEL_ID,
      messages: [{ role: "user", content: "hi" }]
    });

    expect(response.status).toBe(503);
    expect(response.text).toContain("retryable");
  });
});
