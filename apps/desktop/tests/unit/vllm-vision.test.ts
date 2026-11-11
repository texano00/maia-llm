import { describe, expect, it } from "vitest";
import { buildContent } from "../../src/main/services/inference/vllm";

describe("vLLM message content", () => {
  it("sends a plain string when the turn has no images", () => {
    expect(buildContent("hello", undefined)).toBe("hello");
    expect(buildContent("hello", [])).toBe("hello");
  });

  it("sends OpenAI vision parts with a data URL per image", () => {
    const content = buildContent("what is this?", [
      { mimeType: "image/png", dataBase64: "AAAA" },
      { mimeType: "image/jpeg", dataBase64: "BBBB" }
    ]);

    expect(content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } }
    ]);
  });
});
