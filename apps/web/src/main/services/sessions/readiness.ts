import type { ReleaseReason } from "@maia/contracts";

/**
 * Proving that a model can actually serve (feature 011, FR-001).
 *
 * A reachable port and a healthy process are preconditions, not a verdict: vLLM
 * answers `/health` while the engine core is still finishing, and a container can
 * listen for minutes without producing a token. One real request settles it, and
 * it settles it the same way for both engines.
 */

export interface InferenceProbeOptions {
  /** `http://host:port` — the `/v1` path is added here. */
  baseUrl: string;
  modelId: string;
  apiKey: string;
  /** Chat models get a chat probe; text-only models fall back once. */
  chat?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type InferenceProbeResult =
  | { kind: "serving"; models: string[] }
  /**
   * `answered` separates "the port replied and the engine is busy" from "nothing
   * is listening yet": llama.cpp answers 503 "Loading model" for as long as the
   * weights take to arrive, which is the only evidence a buffered log never gives.
   * `detail` is the engine's own sentence, when it wrote one.
   */
  | { kind: "waiting"; answered?: boolean; detail?: string }
  /** The route exists but the engine rejected the request for a model reason. */
  | { kind: "failed"; reason: ReleaseReason; detail: string };

function timeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * One probe. `waiting` covers every transient answer (refused, 500, 503, a
 * half-loaded engine) because those all mean "ask again".
 */
export async function probeInference(options: InferenceProbeOptions): Promise<InferenceProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const authorization = { authorization: `Bearer ${options.apiKey}` };

  const chat = options.chat !== false;
  if (chat) {
    const answer = await post(
      fetchImpl,
      `${options.baseUrl}/v1/chat/completions`,
      {
        model: options.modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0,
        stream: false
      },
      authorization,
      timeoutMs
    );

    if (answer.kind === "ok") {
      return { kind: "serving", models: [options.modelId] };
    }

    // A text-only model has no chat route; one completion probe answers instead.
    if (answer.kind === "not-found") {
      const completion = await post(
        fetchImpl,
        `${options.baseUrl}/v1/completions`,
        { model: options.modelId, prompt: "ping", max_tokens: 1, stream: false },
        authorization,
        timeoutMs
      );
      if (completion.kind === "ok") {
        return { kind: "serving", models: [options.modelId] };
      }
      if (completion.kind === "not-found") {
        return {
          kind: "failed",
          reason: "model_load_failed",
          detail: "The server does not answer chat or completion requests for this model."
        };
      }
      return completion;
    }

    return answer;
  }

  const completion = await post(
    fetchImpl,
    `${options.baseUrl}/v1/completions`,
    { model: options.modelId, prompt: "ping", max_tokens: 1, stream: false },
    authorization,
    timeoutMs
  );

  if (completion.kind === "ok") {
    return { kind: "serving", models: [options.modelId] };
  }

  return completion.kind === "not-found"
    ? { kind: "failed", reason: "model_load_failed", detail: "The model is not served by this endpoint." }
    : completion;
}

/**
 * Asks the OpenAI surface to produce one token.
 *
 * `not-found` is told apart from `waiting` because the first is a verdict about
 * the model and the second is patience.
 */
async function post(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ kind: "ok" } | { kind: "not-found" } | { kind: "waiting"; answered: boolean; detail?: string }> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: timeout(timeoutMs)
    });

    if (response.status === 404) {
      return { kind: "not-found" };
    }

    if (!response.ok) {
      // A non-OK answer is still an answer: the engine is up and has something
      // to say about why it cannot serve yet.
      const detail = engineMessage(await readBody(response));
      return detail === undefined
        ? { kind: "waiting", answered: true }
        : { kind: "waiting", answered: true, detail };
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { role?: string }; text?: string }>;
    };
    const choice = payload.choices?.[0];
    if (!choice || (choice.message === undefined && choice.text === undefined)) {
      return { kind: "waiting", answered: true };
    }

    return { kind: "ok" };
  } catch {
    // Connection refused, DNS, timeout: the server is not answering yet.
    return { kind: "waiting", answered: false };
  }
}

/** Reads a small error body without letting a large one stall the probe. */
async function readBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return "";
  }
}

/**
 * The engine's own words, short enough to sit on a run card: llama.cpp answers
 * `{"error":{"message":"Loading model"}}` while it loads, vLLM writes a longer
 * sentence about the engine core. Anything unreadable degrades to nothing.
 */
function engineMessage(body: string): string | undefined {
  const text = body.trim();
  if (text.length === 0) {
    return undefined;
  }

  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof parsed.error === "object" && parsed.error !== null && typeof parsed.error.message === "string") {
      message = parsed.error.message;
    } else if (typeof parsed.error === "string") {
      message = parsed.error;
    } else if (typeof parsed.message === "string") {
      message = parsed.message;
    }
  } catch {
    // Plain text is fine: keep it as it is.
  }

  const clean = message.replace(/\s+/g, " ").trim();
  if (clean.length === 0) {
    return undefined;
  }

  return clean.length > 120 ? `${clean.slice(0, 117)}…` : clean;
}

/**
 * Provider statuses that flicker while a container works. A single report never
 * ends an attempt; only a sustained one does.
 */
export function isTransientStatus(status: string): boolean {
  return status === "unknown" || status === "offline";
}

/** Statuses that mean the machine will not come back. */
export function isGoneStatus(status: string): boolean {
  return status === "exited" || status === "error" || status === "destroyed";
}

/** Human sentence for the moment the ceiling is crossed. */
export function describeCeiling(input: {
  elapsedMs: number;
  ceilingMs: number;
  phase: string | null;
}): string {
  const minutes = Math.round(input.elapsedMs / 60_000);
  const ceiling = Math.round(input.ceilingMs / 60_000);
  const phase = input.phase ? ` (${input.phase})` : "";
  return `Not ready after ${minutes} min, past the ${ceiling}-minute ceiling${phase}. The GPU is still rented — stop it if you do not want to wait.`;
}
