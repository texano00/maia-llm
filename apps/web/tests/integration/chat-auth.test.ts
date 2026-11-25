import { describe, expect, it } from "vitest";
import { createVllmRuntime } from "../../src/main/services/inference/vllm";

function sse(body: unknown): ReadableStream<Uint8Array> {
  const text = `data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}

function okResponse(): Response {
  return new Response(
    sse({
      choices: [{ delta: { content: "hello" }, finish_reason: "stop" }],
      usage: { completion_tokens: 1 }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

function unauthorized(): Response {
  return new Response("unauthorized", { status: 401 });
}

describe("chat authentication", () => {
  it("sends the run key as a bearer token", async () => {
    const seen: Array<Record<string, string>> = [];
    const runtime = createVllmRuntime({
      resolveEndpoint: () => ({ host: "127.0.0.1", port: 8000 }),
      fetchImpl: async (_url, init) => {
        seen.push((init?.headers ?? {}) as Record<string, string>);
        return okResponse();
      }
    });

    const result = await runtime.stream({
      sessionId: "s1",
      modelId: "org/model",
      instanceId: 1,
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      apiKey: "maia_secret",
      onDelta: () => undefined
    });

    expect(result.text).toBe("hello");
    expect(seen[0]?.authorization).toBe("Bearer maia_secret");
  });

  it("does not invent a header when the run has no key", async () => {
    let headers: Record<string, string> = {};
    const runtime = createVllmRuntime({
      resolveEndpoint: () => ({ host: "127.0.0.1", port: 8000 }),
      fetchImpl: async (_url, init) => {
        headers = (init?.headers ?? {}) as Record<string, string>;
        return okResponse();
      }
    });

    await runtime.stream({
      sessionId: "s1",
      modelId: "org/model",
      instanceId: 1,
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      apiKey: null,
      onDelta: () => undefined
    });

    expect(headers.authorization).toBeUndefined();
  });

  it("retries once after a 401, re-resolving the endpoint", async () => {
    let calls = 0;
    let resolutions = 0;
    const runtime = createVllmRuntime({
      resolveEndpoint: () => {
        resolutions += 1;
        return { host: "127.0.0.1", port: 8000 + resolutions };
      },
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? unauthorized() : okResponse();
      }
    });

    const result = await runtime.stream({
      sessionId: "s1",
      modelId: "org/model",
      instanceId: 1,
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      apiKey: "maia_secret",
      onDelta: () => undefined
    });

    expect(result.text).toBe("hello");
    expect(calls).toBe(2);
    expect(resolutions).toBe(2);
  });

  it("stops after two 401s with a plain message", async () => {
    let calls = 0;
    const runtime = createVllmRuntime({
      resolveEndpoint: () => ({ host: "127.0.0.1", port: 8000 }),
      fetchImpl: async () => {
        calls += 1;
        return unauthorized();
      }
    });

    await expect(
      runtime.stream({
        sessionId: "s1",
        modelId: "org/model",
        instanceId: 1,
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
        apiKey: "maia_wrong",
        onDelta: () => undefined
      })
    ).rejects.toThrow(/rejected the run's key/);

    expect(calls).toBe(2);
  });
});
