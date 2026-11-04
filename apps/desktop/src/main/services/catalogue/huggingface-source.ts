import type { CatalogueSource } from "./service";
import type { HuggingFaceModelPayload, HuggingFaceTreeEntry } from "./mapper";
import { ProviderHttpClient, ProviderHttpError } from "../providers/http";
import { baseModelCandidate } from "../inference/model-plan";

interface HuggingFaceSibling {
  rfilename?: string;
  size?: number;
  lfs?: { sha256?: string; size?: number } | null;
}

interface HuggingFaceDetailPayload extends HuggingFaceModelPayload {
  siblings?: HuggingFaceSibling[];
}

/**
 * Hugging Face routes keep the namespace slash literal; encoding it as %2F makes
 * the API answer 400/404, which surfaced as "Provider request failed" whenever a
 * model was selected.
 */
export function modelPath(id: string): string {
  return id
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export interface HuggingFaceSourceOptions {
  /** Resolved lazily so a token saved in Settings applies without a restart. */
  getToken?: () => Promise<string | undefined>;
  client?: ProviderHttpClient;
}

export function createHuggingFaceSource(options: HuggingFaceSourceOptions = {}): CatalogueSource {
  const client =
    options.client ??
    new ProviderHttpClient({
      baseUrl: "https://huggingface.co",
      timeoutMs: 15_000,
      maxRetries: 2
    });

  async function headers(): Promise<Record<string, string>> {
    const token = await options.getToken?.();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  /** A raw repository file, or null when the repository does not ship it. */
  async function readOptionalFile(path: string): Promise<string | null> {
    try {
      const response = await client.request(path, { headers: await headers() });
      return await response.text();
    } catch (error) {
      // Missing files are the normal case: most base models ship no template.
      if (
        error instanceof ProviderHttpError &&
        (error.status === 404 || error.status === 400)
      ) {
        return null;
      }
      throw error;
    }
  }

  return {
    async listModels({ search, limit }) {
      const params = new URLSearchParams({
        limit: String(limit),
        sort: "downloads",
        direction: "-1",
        // Without this the Hub happily returns embedding, reranking and ASR
        // models, which boot on a GPU and then answer every chat request with
        // 404 because vLLM exposes no chat endpoint for them.
        filter: "text-generation",
        full: "true"
      });
      if (search) {
        params.set("search", search);
      }

      const response = await client.request(`/api/models?${params.toString()}`, {
        headers: await headers()
      });

      return (await response.json()) as HuggingFaceModelPayload[];
    },

    async getModel(id) {
      const response = await client.request(`/api/models/${modelPath(id)}?blobs=true`, {
        headers: await headers()
      });

      const payload = (await response.json()) as HuggingFaceDetailPayload;
      const files: HuggingFaceTreeEntry[] = (payload.siblings ?? []).map((sibling) => ({
        type: "file" as const,
        path: sibling.rfilename ?? "",
        size: sibling.size ?? 0,
        lfs: sibling.lfs ?? null
      }));

      return { model: payload, files };
    },

    /**
     * `true` when the repository defines a chat template — or, for a community
     * GGUF mirror that ships little but `*.gguf` shards, when the repository it
     * was quantised from does. That base repository is also the tokenizer vLLM
     * is pointed at, so its verdict is the one chat traffic depends on.
     */
    async getChatTemplate(id) {
      if (await probeChatTemplate(id)) {
        return true;
      }

      const base = baseModelCandidate(id);
      return base !== null && (await probeChatTemplate(base));
    }
  };

  /**
   * The three places a repository can declare a chat template. A missing file is
   * the normal case for a base model, so a 404/400 resolves to `false` instead
   * of throwing; any other error propagates and becomes an "unknown" verdict.
   */
  async function probeChatTemplate(id: string): Promise<boolean> {
    const root = `/${modelPath(id)}/raw/main`;

    const config = await readOptionalFile(`${root}/tokenizer_config.json`);
    if (config !== null && tokenizerConfigHasTemplate(config)) {
      return true;
    }

    // Newer repositories ship the template as a standalone jinja file…
    const jinja = await readOptionalFile(`${root}/chat_template.jinja`);
    if (jinja !== null && jinja.trim().length > 0) {
      return true;
    }

    // …or as JSON, depending on the repository's tokenizer tooling.
    const json = await readOptionalFile(`${root}/chat_template.json`);
    return json !== null && tokenizerConfigHasTemplate(json);
  }
}

/**
 * `chat_template` is a string in the classic format and a list of named
 * `{ name, template }` entries in the newer multi-template format. A `null` or
 * an empty string means the tokenizer defines none.
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
  const hasText = (value: unknown): boolean =>
    typeof value === "string" && value.trim().length > 0;

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

/** Cheap authenticated probe used by the "Test connection" button. */
export async function testHuggingFaceToken(token: string, client?: ProviderHttpClient): Promise<boolean> {
  const http =
    client ??
    new ProviderHttpClient({
      baseUrl: "https://huggingface.co",
      timeoutMs: 10_000,
      maxRetries: 0
    });

  const response = await http.request("/api/whoami-v2", {
    headers: { authorization: `Bearer ${token}` }
  });

  return response.ok;
}
