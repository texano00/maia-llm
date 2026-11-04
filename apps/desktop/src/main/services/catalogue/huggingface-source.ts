import type { CatalogueSource } from "./service";
import type { HuggingFaceModelPayload, HuggingFaceTreeEntry } from "./mapper";
import { ProviderHttpClient } from "../providers/http";

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
    }
  };
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
