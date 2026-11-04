import { InvalidOptionError } from "./errors";

/** Sampling parameters vLLM accepts, already normalised. */
export interface GenerationParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  maxTokens?: number;
  stop?: string[];
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  repeatPenalty?: number;
  numCtx?: number;
  jsonMode?: boolean;
}

export interface MappedOptions {
  params: GenerationParams;
  /** Ollama options this endpoint ignores; echoed back to the caller. */
  ignored: string[];
}

/**
 * Maps the Ollama `options` object onto vLLM's OpenAI parameters.
 *
 * Values are validated rather than passed through: an assistant extension that
 * sends `temperature: "hot"` must get a clear 400 instead of a vLLM 422 that
 * mentions a field nobody typed.
 */
export function mapOllamaOptions(raw: unknown, contextWindow: number | null): MappedOptions {
  if (raw === undefined || raw === null) {
    return { params: {}, ignored: [] };
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidOptionError("options must be an object");
  }

  const source = raw as Record<string, unknown>;
  const params: GenerationParams = {};
  const ignored: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) {
      continue;
    }

    switch (key) {
      case "temperature":
        params.temperature = clampNumber(key, value, 0, 2);
        break;
      case "top_p":
        params.topP = clampNumber(key, value, 0, 1);
        break;
      case "top_k":
        params.topK = integer(key, value, 0);
        break;
      case "min_p":
        params.minP = clampNumber(key, value, 0, 1);
        break;
      case "num_predict": {
        // -1 is "until the model stops" in Ollama; vLLM expresses that as absent.
        const requested = finiteNumber(key, value);
        if (requested > 0) {
          params.maxTokens = integer(key, value, 1);
        }
        break;
      }
      case "num_ctx": {
        const requested = integer(key, value, 128);
        // The running server has one context length; asking for more cannot be
        // honoured, so clamp instead of failing the request.
        params.numCtx = contextWindow ? Math.min(requested, contextWindow) : requested;
        break;
      }
      case "seed":
        params.seed = integer(key, value, 0);
        break;
      case "repeat_penalty":
        params.repeatPenalty = clampNumber(key, value, 0, 5);
        break;
      case "presence_penalty":
        params.presencePenalty = clampNumber(key, value, -2, 2);
        break;
      case "frequency_penalty":
        params.frequencyPenalty = clampNumber(key, value, -2, 2);
        break;
      case "stop": {
        const sequences = stopSequences(key, value);
        if (sequences) {
          params.stop = sequences;
        }
        break;
      }
      case "format":
        if (value === "json") {
          params.jsonMode = true;
          break;
        }
        // A JSON schema needs guided decoding, which the rented server does not
        // advertise; silently returning prose would break the caller's parser.
        throw new InvalidOptionError("format: structured output is not supported by this endpoint; only format: \"json\" is accepted");
      default:
        // Known Ollama knobs without a vLLM equivalent, and anything unknown to
        // us: reported back in `X-Maia-Ignored-Options` instead of failing.
        ignored.push(key);
    }
  }

  return { params, ignored };
}

function stopSequences(key: string, value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? [value] : undefined;
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value.filter((entry: string) => entry.length > 0);
  }

  throw new InvalidOptionError(`${key} must be a string or an array of strings`);
}

function finiteNumber(key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidOptionError(`${key} must be a number`);
  }

  return value;
}

function clampNumber(key: string, value: unknown, min: number, max: number): number {
  return Math.min(max, Math.max(min, finiteNumber(key, value)));
}

function integer(key: string, value: unknown, min: number): number {
  const parsed = finiteNumber(key, value);

  if (!Number.isInteger(parsed) || parsed < min) {
    throw new InvalidOptionError(`${key} must be an integer >= ${min}`);
  }

  return parsed;
}
