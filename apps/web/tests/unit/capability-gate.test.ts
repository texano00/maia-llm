import { describe, expect, it } from "vitest";
import { capabilityForPipelineTag, isChatCapableModel } from "@maia/contracts";

describe("model capability", () => {
  it("maps image-to-text pipelines to the image-to-text capability", () => {
    expect(capabilityForPipelineTag("image-text-to-text")).toBe("image-to-text");
    expect(capabilityForPipelineTag("visual-question-answering")).toBe("image-to-text");
  });

  it("maps image output pipelines and keeps them out of text runs", () => {
    expect(capabilityForPipelineTag("text-to-image")).toBe("text-to-image");
    expect(capabilityForPipelineTag("image-to-image")).toBe("image-to-image");
  });

  it("defaults to text for chat, unknown or missing tags", () => {
    expect(capabilityForPipelineTag("text-generation")).toBe("text");
    expect(capabilityForPipelineTag(null)).toBe("text");
    expect(capabilityForPipelineTag("feature-extraction")).toBe("text");
  });

  it("keeps vision chat models runnable and refuses image generators", () => {
    // Image-to-text goes through the existing chat endpoint with image content
    // parts, so it stays runnable.
    expect(isChatCapableModel({ pipelineTag: "image-text-to-text" })).toBe(true);
    expect(isChatCapableModel({ pipelineTag: "visual-question-answering" })).toBe(true);

    // A diffusion model has no chat endpoint: renting it would boot and then
    // answer every request with 404.
    expect(isChatCapableModel({ pipelineTag: "text-to-image" })).toBe(false);
    expect(isChatCapableModel({ pipelineTag: "image-to-image" })).toBe(false);
  });
});
