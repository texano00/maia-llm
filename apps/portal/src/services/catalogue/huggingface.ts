import { baseModelCandidate, type HubModelPayload, type HubSibling } from "./model.js";

export interface CatalogueClient {
  /** Newest most-downloaded text-generation models, with their file list. */
  listModels(limit: number): Promise<HubModelPayload[]>;
  /** Files with sizes; the listing endpoint omits them. */
  getFiles(modelId: string): Promise<HubSibling[]>;
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
      const params = new URLSearchParams({
        filter: "text-generation",
        sort: "downloads",
        direction: "-1",
        limit: String(limit),
        full: "true"
      });
      const response = await get(`/api/models?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Hugging Face catalogue listing failed with ${response.status}`);
      }

      return (await response.json()) as HubModelPayload[];
    },

    async getFiles(modelId) {
      const response = await get(`/api/models/${modelPath(modelId)}?blobs=true`);
      if (!response.ok) {
        throw new Error(`Hugging Face model ${modelId} failed with ${response.status}`);
      }

      const payload = (await response.json()) as HubModelPayload;
      return payload.siblings ?? [];
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
