import { describe, expect, it } from "vitest";
import {
  buildEditorConfig,
  buildOpenAiRequest,
  maskKey
} from "../../src/renderer/features/models/external-access";

const ENDPOINT = {
  baseUrl: "http://203.0.113.10:41234/v1",
  modelId: "Qwen/Qwen2.5-7B-Instruct",
  apiKey: "maia-3f9c1de4a7b24c6e8f0d"
};

describe("external access snippets", () => {
  it("builds an OpenAI-compatible request with the endpoint, model and key", () => {
    const snippet = buildOpenAiRequest(ENDPOINT);

    expect(snippet).toContain("http://203.0.113.10:41234/v1/chat/completions");
    expect(snippet).toContain(ENDPOINT.modelId);
    expect(snippet).toContain(`Bearer ${ENDPOINT.apiKey}`);
  });

  it("builds an editor configuration the user can paste", () => {
    const snippet = buildEditorConfig(ENDPOINT);

    expect(snippet).toContain(ENDPOINT.baseUrl);
    expect(snippet).toContain(ENDPOINT.modelId);
    expect(snippet).toContain(ENDPOINT.apiKey);
    // JSON, so it can go straight into settings.json.
    expect(() => JSON.parse(snippet)).not.toThrow();
  });

  it("masks the key until the user reveals it", () => {
    const masked = maskKey(ENDPOINT.apiKey);

    expect(masked).not.toBe(ENDPOINT.apiKey);
    expect(masked).not.toContain(ENDPOINT.apiKey.slice(4, -4));
    expect(masked.startsWith("maia")).toBe(true);
    expect(masked.endsWith(ENDPOINT.apiKey.slice(-4))).toBe(true);
  });

  it("masks short keys completely", () => {
    expect(maskKey("abc")).toBe("•••");
  });
});
