import type { InferenceRuntime, StreamKind } from "../sessions/orchestrator";

export interface VllmRuntimeOptions {
  /** Resolves the mapped host/port for a running instance. */
  resolveEndpoint: (instanceId: number) => { host: string; port: number } | null;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { completion_tokens?: number; prompt_tokens?: number };
}

/**
 * OpenAI-compatible streaming against the vLLM server running on the rented
 * instance. Reasoning tokens (`reasoning_content`) are forwarded separately from
 * the answer so the UI can show a "thinking" block.
 */
export function createVllmRuntime(options: VllmRuntimeOptions): InferenceRuntime {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async stream({ modelId, instanceId, prompt, signal, onDelta }) {
      if (instanceId === null) {
        throw new Error("The model instance is not available.");
      }

      const endpoint = options.resolveEndpoint(instanceId);
      if (!endpoint) {
        throw new Error("The model endpoint is not reachable; the GPU may have been released.");
      }

      const response = await fetchImpl(`http://${endpoint.host}:${endpoint.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: prompt }],
          stream: true,
          stream_options: { include_usage: true }
        }),
        signal
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");

        // vLLM only registers /v1/chat/completions for generative models: a 404
        // means the endpoint exists but this model has no chat surface, which is
        // what an embedding or reranking model looks like from here.
        if (response.status === 404) {
          throw new Error(
            "The model server has no chat endpoint (HTTP 404). This model was probably not a text-generation model, so no conversation can be served from it."
          );
        }

        // A base/completion model (gpt2, llama-base…) defines no chat template,
        // and transformers v4.44+ refuses to guess one: every chat request is a
        // 400 even though the server is healthy.
        if (response.status === 400 && /chat template/i.test(detail)) {
          throw new Error(
            "The model server rejected the request because this model defines no chat template (HTTP 400). It is a base/completion model, not an instruct or chat model — end this session and pick a chat model."
          );
        }

        throw new Error(
          `The model server rejected the request (HTTP ${response.status}). ${detail.slice(0, 200)}`.trim()
        );
      }

      let text = "";
      let tokens = 0;

      for await (const chunk of parseSseStream(response.body)) {
        const parsed = parseChunk(chunk);
        if (!parsed) {
          continue;
        }

        for (const choice of parsed.choices ?? []) {
          const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
          if (reasoning) {
            onDelta("reasoning" satisfies StreamKind, reasoning);
          }
          if (choice.delta?.content) {
            text += choice.delta.content;
            onDelta("content", choice.delta.content);
          }
        }

        if (parsed.usage?.completion_tokens) {
          tokens = parsed.usage.completion_tokens;
        }
      }

      return { tokens: tokens || Math.max(1, Math.ceil(text.length / 4)), text };
    }
  };
}

export function parseChunk(raw: string): ChatCompletionChunk | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(trimmed) as ChatCompletionChunk;
  } catch {
    return null;
  }
}

/** Minimal SSE reader: yields the payload of each `data:` line. */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          yield trimmed.slice("data:".length).trim();
        }
      }
    }

    if (buffer.trim().startsWith("data:")) {
      yield buffer.trim().slice("data:".length).trim();
    }
  } finally {
    reader.releaseLock();
  }
}
