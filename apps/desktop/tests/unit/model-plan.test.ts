import { describe, expect, it } from "vitest";
import type { ModelArtifact } from "@maia/contracts";
import {
  baseModelCandidate,
  GGUF_PLUGIN_INSTALL,
  planVllmModel,
  quantizationFromPath
} from "../../src/main/services/inference/model-plan";

function artifact(overrides: Partial<ModelArtifact>): ModelArtifact {
  return {
    id: "a1",
    modelId: "org/model",
    revision: "main",
    path: "model.safetensors",
    format: "safetensors",
    quantization: null,
    sizeBytes: 1_000,
    sha256: null,
    isLfs: true,
    runnable: true,
    ...overrides
  };
}

describe("vLLM model planning", () => {
  it("passes a safetensors repository straight through", () => {
    const plan = planVllmModel({
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      artifacts: [artifact({ path: "model-00001-of-00002.safetensors" })]
    });

    expect(plan).toEqual({
      modelArg: "Qwen/Qwen2.5-7B-Instruct",
      extraArgs: [],
      env: {},
      gguf: false
    });
  });

  it("serves a GGUF repository through the plugin with repo:QUANT", () => {
    const plan = planVllmModel({
      modelId: "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF",
      artifacts: [
        artifact({ path: "Huihui-Q4_K_M.gguf", format: "gguf", quantization: "Q4_K_M" }),
        artifact({ path: "Huihui-Q8_0.gguf", format: "gguf", quantization: "Q8_0" })
      ],
      tokenizer: "huihui-ai/Huihui-Qwen3.8-27B-abliterated"
    });

    expect(plan.modelArg).toBe("huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF:Q4_K_M");
    expect(plan.gguf).toBe(true);
    expect(plan.quantization).toBe("Q4_K_M");
    expect(plan.onstart).toBe(GGUF_PLUGIN_INSTALL);
    // The plugin derives the quantisation from `repo:QUANT`; the tokenizer is
    // the only extra argument its docs require.
    expect(plan.extraArgs).toEqual(["--tokenizer", "huihui-ai/Huihui-Qwen3.8-27B-abliterated"]);
  });

  it("prefers the best quantisation a repository actually ships", () => {
    const plan = planVllmModel({
      modelId: "org/model-GGUF",
      artifacts: [
        artifact({ path: "model-Q2_K.gguf", format: "gguf", quantization: "Q2_K" }),
        artifact({ path: "model-Q5_K_M.gguf", format: "gguf", quantization: "Q5_K_M" })
      ]
    });

    expect(plan.modelArg).toBe("org/model-GGUF:Q5_K_M");
  });

  it("derives the quantisation from the filename when the catalogue has none", () => {
    expect(quantizationFromPath("model-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(quantizationFromPath("Meta-Llama-3.1-8B-Instruct.IQ4_XS.gguf")).toBe("IQ4_XS");
    expect(quantizationFromPath("weights.gguf")).toBeNull();
  });

  it("keeps safetensors when a repository ships both formats", () => {
    const plan = planVllmModel({
      modelId: "org/model",
      artifacts: [
        artifact({ path: "model-Q4_K_M.gguf", format: "gguf", quantization: "Q4_K_M" }),
        artifact({ path: "model.safetensors" })
      ]
    });

    expect(plan.modelArg).toBe("org/model");
    expect(plan.onstart).toBeUndefined();
  });

  it("finds the base repository behind a GGUF release", () => {
    expect(baseModelCandidate("huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF")).toBe(
      "huihui-ai/Huihui-Qwen3.8-27B-abliterated"
    );
    expect(baseModelCandidate("org/model-gguf")).toBe("org/model");
    expect(baseModelCandidate("Qwen/Qwen2.5-7B-Instruct")).toBeNull();
  });
});
