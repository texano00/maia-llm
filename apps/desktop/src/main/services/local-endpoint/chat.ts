import { parseChunk, parseSseStream } from "../inference/vllm";
import { UpstreamError } from "./errors";
import type { GenerationParams } from "./options";

export interface UpstreamTarget {
  host: string;
  port: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ProxyChatInput {
  target: UpstreamTarget;
  /** Value for `model`: the `--served-model-name` the session was started with. */
  modelId: string;
  messages: ChatMessage[];
  params: GenerationParams;
  signal: AbortSignal;
  onThinking?: (text: string) => void;
  onContent: (text: string) => void;
  fetchImpl?: typeof fetch;
}

export interface ProxyChatResult {
  text: string;
  thinking: string;
  tokens: number;
  promptTokens: number | null;
}

/**
 * Forwards an OpenAI-shaped chat completion to the rented vLLM server.
 *
 * The in-app chat path sends a single user prompt; IDE assistants need the whole
 * conversation plus sampling options, so this talks to the same endpoint with a
 * fuller body instead of going through the session runtime.
 */
export async function proxyChatCompletion(input: ProxyChatInput): Promise<ProxyChatResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const { params } = input;

  const response = await fetchImpl(`http://${input.target.host}:${input.target.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: input.modelId,
      messages: input.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.topP !== undefined ? { top_p: params.topP } : {}),
      ...(params.topK !== undefined ? { top_k: params.topK } : {}),
      ...(params.minP !== undefined ? { min_p: params.minP } : {}),
      ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
      ...(params.stop ? { stop: params.stop } : {}),
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
      ...(params.presencePenalty !== undefined ? { presence_penalty: params.presencePenalty } : {}),
      ...(params.frequencyPenalty !== undefined ? { frequency_penalty: params.frequencyPenalty } : {}),
      ...(params.jsonMode ? { response_format: { type: "json_object" } } : {})
    }),
    signal: input.signal
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");

    if (response.status === 404) {
      throw new UpstreamError(
        404,
        "the model server has no chat endpoint; the running model is not a chat model"
      );
    }

    if (response.status === 400 && /chat template/i.test(detail)) {
      throw new UpstreamError(
        400,
        "the running model defines no chat template, so it cannot answer chat completions"
      );
    }

    throw new UpstreamError(
      response.status,
      `the model server rejected the request (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`
    );
  }

  let text = "";
  let thinking = "";
  let tokens = 0;
  let promptTokens: number | null = null;

  for await (const chunk of parseSseStream(response.body)) {
    const parsed = parseChunk(chunk);
    if (!parsed) {
      continue;
    }

    for (const choice of parsed.choices ?? []) {
      const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
      if (reasoning) {
        thinking += reasoning;
        input.onThinking?.(reasoning);
      }

      if (choice.delta?.content) {
        text += choice.delta.content;
        input.onContent(choice.delta.content);
      }
    }

    if (parsed.usage) {
      if (typeof parsed.usage.completion_tokens === "number") {
        tokens = parsed.usage.completion_tokens;
      }
      if (typeof parsed.usage.prompt_tokens === "number") {
        promptTokens = parsed.usage.prompt_tokens;
      }
    }
  }

  return {
    text,
    thinking,
    tokens: tokens || Math.max(1, Math.ceil(text.length / 4)),
    promptTokens
  };
}
