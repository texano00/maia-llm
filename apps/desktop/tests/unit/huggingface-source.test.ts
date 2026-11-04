import { describe, expect, it, vi } from "vitest";
import { createHuggingFaceSource } from "../../src/main/services/catalogue/huggingface-source";

describe("Hugging Face catalogue source", () => {
  it("asks only for text-generation models", async () => {
    const urls: string[] = [];
    const client = {
      request: vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify([]), { status: 200 });
      })
    };

    const source = createHuggingFaceSource({ client: client as never });
    await source.listModels({ limit: 100 });
    await source.listModels({ limit: 20, search: "qwen" });

    // Unfiltered, the Hub also returns embedding and reranking models, which
    // boot on a GPU and then reject every chat request with 404.
    expect(urls[0]).toContain("filter=text-generation");
    expect(urls[1]).toContain("filter=text-generation");
    expect(urls[1]).toContain("search=qwen");
  });

  it("sends the token when the user configured one", async () => {
    const headers: Array<Record<string, string>> = [];
    const client = {
      request: vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
        headers.push(init.headers ?? {});
        return new Response(JSON.stringify([]), { status: 200 });
      })
    };

    const source = createHuggingFaceSource({
      client: client as never,
      getToken: async () => "hf_test"
    });

    await source.listModels({ limit: 1 });

    expect(headers[0]?.authorization).toBe("Bearer hf_test");
  });
});
