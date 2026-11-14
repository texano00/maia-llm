import { baseModelCandidate, type HubModelPayload, type HubSibling } from "./model.js";

export interface CatalogueClient {
  /** Newest most-downloaded text-generation models, with their file list. */
  listModels(limit: number): Promise<HubModelPayload[]>;
  /** Files with sizes; the listing endpoint omits them. */
  getFiles(modelId: string): Promise<HubSibling[]>;
  /** One repository by id, for the always-included list. `null` when absent. */
  readModel(modelId: string): Promise<HubModelPayload | null>;
  /** Chat-template verdict, following a GGUF mirror to its base repository. */
  hasChatTemplate(modelId: string): Promise<boolean>;
}

export interface HuggingFaceCatalogueClientOptions {
  /** Service credential from static configuration; never sent to clients. */
  token: string | null;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://huggingface.co";

/**
 * Pipeline tags whose repositories can answer a chat request.
 *
 * Must stay in step with `CHAT_PIPELINE_TAGS` in `model.ts` and in
 * `@maia/contracts`: the listing has to be able to *see* everything the mapping
 * and the runtime accept.
 */
const LISTED_PIPELINE_TAGS = ["text-generation", "image-text-to-text"] as const;

const LISTING_SORTS = ["downloads", "lastModified"] as const;

export function modelPath(id: string): string {
  return id
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Reads the open-weight catalogue server-side.
 *
 * Everything the desktop used to derive from the Hub is derived here instead, so
 * a client can browse with the Hub down and the same verdicts are shared by every
 * installation.
 */
export function createHuggingFaceCatalogueClient(
  options: HuggingFaceCatalogueClientOptions
): CatalogueClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;

  const headers = (): Record<string, string> =>
    options.token ? { authorization: `Bearer ${options.token}` } : {};

  async function get(path: string): Promise<Response> {
    return fetchImpl(`${baseUrl}${path}`, { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
  }

  /** One page of the public listing for one pipeline tag. */
  async function list(options: {
    pipelineTag: string;
    sort: "downloads" | "lastModified";
    limit: number;
  }): Promise<HubModelPayload[]> {
    const params = new URLSearchParams({
      filter: options.pipelineTag,
      sort: options.sort,
      direction: "-1",
      limit: String(options.limit),
      full: "true"
    });
    const response = await get(`/api/models?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Hugging Face catalogue listing failed with ${response.status}`);
    }

    return (await response.json()) as HubModelPayload[];
  }

  async function readOptional(path: string): Promise<string | null> {
    const response = await get(path);
    if (response.status === 404 || response.status === 400) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Hugging Face ${path} failed with ${response.status}`);
    }

    return response.text();
  }

  async function probeTemplate(modelId: string): Promise<boolean> {
    const root = `/${modelPath(modelId)}/raw/main`;

    const config = await readOptional(`${root}/tokenizer_config.json`);
    if (config !== null && tokenizerConfigHasTemplate(config)) {
      return true;
    }

    const jinja = await readOptional(`${root}/chat_template.jinja`);
    if (jinja !== null && jinja.trim().length > 0) {
      return true;
    }

    const json = await readOptional(`${root}/chat_template.json`);
    return json !== null && tokenizerConfigHasTemplate(json);
  }

  return {
    async listModels(limit) {
      // Chat models are declared under more than one pipeline tag, and the Hub
      // filters on exactly one per request. `huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF`
      // is tagged `image-text-to-text` (it ships an mmproj), so a
      // `text-generation`-only listing could never contain it, however popular it
      // became. Each tag is read twice as well: the download ranking never holds a
      // repository published last week, and the recency ranking never holds the
      // models people search for.
      const pages = await Promise.all(
        LISTED_PIPELINE_TAGS.flatMap((pipelineTag) =>
          LISTING_SORTS.map((sort) => list({ pipelineTag, sort, limit }))
        )
      );

      const seen = new Set<string>();
      const merged: HubModelPayload[] = [];
      for (const page of pages) {
        for (const payload of page) {
          if (!payload.id || seen.has(payload.id)) {
            continue;
          }
          seen.add(payload.id);
          merged.push(payload);
        }
      }

      return merged;
    },

    async getFiles(modelId) {
      const response = await get(`/api/models/${modelPath(modelId)}?blobs=true`);
      if (!response.ok) {
        throw new Error(`Hugging Face model ${modelId} failed with ${response.status}`);
      }

      const payload = (await response.json()) as HubModelPayload;
      return payload.siblings ?? [];
    },

    async readModel(modelId) {
      const response = await get(`/api/models/${modelPath(modelId)}`);
      if (response.status === 404 || response.status === 400) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`Hugging Face model ${modelId} failed with ${response.status}`);
      }

      return (await response.json()) as HubModelPayload;
    },

    async hasChatTemplate(modelId) {
      if (await probeTemplate(modelId)) {
        return true;
      }

      // A community GGUF mirror ships only shards; the template lives in the
      // repository it was quantised from — which is also where llama.cpp's
      // tokenizer metadata comes from.
      const base = baseModelCandidate(modelId);
      return base !== null && (await probeTemplate(base));
    }
  };
}

/**
 * `chat_template` is a string in the classic format and a list of named
 * `{ name, template }` entries in the newer multi-template format.
 */
export function tokenizerConfigHasTemplate(raw: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return false;
  }

  if (!payload || typeof payload !== "object") {
    return false;
  }

  const template = (payload as { chat_template?: unknown }).chat_template;
  const hasText = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;

  if (hasText(template)) {
    return true;
  }

  if (Array.isArray(template)) {
    return template.some((entry) => {
      if (hasText(entry)) {
        return true;
      }
      return !!entry && typeof entry === "object" && hasText((entry as { template?: unknown }).template);
    });
  }

  return false;
}
