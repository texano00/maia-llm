import { describe, expect, it } from "vitest";
import type { ModelArtifact } from "@maia/contracts";
import {
  baseModelCandidate,
  bytesPerParameter,
  GGUF_PLUGIN_INSTALL,
  planLaunchLimits,
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

  it("ignores safetensors that vLLM cannot reach in a subfolder", () => {
    // 0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF: the only
    // config.json and shards live under GSQ-3bit/, so `vllm serve <repo>` must
    // use the GGUF plugin instead of a plain transformers load.
    const plan = planVllmModel({
      modelId: "0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF",
      artifacts: [
        artifact({ path: "RVN-Q4_K_M.gguf", format: "gguf", quantization: "Q4_K_M" }),
        artifact({ path: "GSQ-3bit/model-00001-of-00065.safetensors" })
      ],
      tokenizer: "0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored"
    });

    expect(plan.gguf).toBe(true);
    expect(plan.modelArg).toBe(
      "0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF:Q4_K_M"
    );
    expect(plan.extraArgs).toEqual([
      "--tokenizer",
      "0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored"
    ]);
  });

  it("skips MTP draft heads and vision projectors when picking a quant", () => {
    const plan = planVllmModel({
      modelId: "org/model-GGUF",
      artifacts: [
        artifact({ path: "RVN-Q4_K_M-mtp.gguf", format: "gguf", quantization: "Q4_K_M" }),
        artifact({ path: "mmproj-model-f16.gguf", format: "gguf", quantization: null }),
        artifact({ path: "RVN-Q4_K_M-vision.gguf", format: "gguf", quantization: "Q4_K_M" }),
        artifact({ path: "RVN-Q5_K_M.gguf", format: "gguf", quantization: "Q5_K_M" })
      ]
    });

    expect(plan.modelArg).toBe("org/model-GGUF:Q5_K_M");
  });

  it("finds the base repository behind a GGUF release", () => {
    expect(baseModelCandidate("huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF")).toBe(
      "huihui-ai/Huihui-Qwen3.8-27B-abliterated"
    );
    expect(baseModelCandidate("org/model-gguf")).toBe("org/model");
    expect(baseModelCandidate("Qwen/Qwen2.5-7B-Instruct")).toBeNull();
  });

  it("caps the context to the GPU instead of trusting a 262k model card", () => {
    // The real failure: a 27B release advertising 262 144 tokens was launched
    // without `--max-model-len`, so vLLM asked for a KV cache that cannot exist
    // on a 24 GB card and the engine core process was killed.
    const plan = planVllmModel({
      modelId: "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF",
      artifacts: [
        artifact({ path: "Huihui-IQ3_S.gguf", format: "gguf", quantization: "IQ3_S" })
      ],
      tokenizer: "huihui-ai/Huihui-Qwen3.8-27B-abliterated",
      vramGb: 24,
      parameterCount: 27_320_697_856,
      contextWindow: 262_144
    });

    expect(plan.limits?.maxModelLen).toBeLessThan(32_768);
    expect(plan.limits?.maxModelLen).toBeGreaterThanOrEqual(4_096);
    expect(plan.extraArgs).toEqual([
      "--tokenizer",
      "huihui-ai/Huihui-Qwen3.8-27B-abliterated",
      "--max-model-len",
      String(plan.limits?.maxModelLen),
      "--gpu-memory-utilization",
      "0.90",
      "--max-num-seqs",
      "4"
    ]);
  });

  it("keeps the full 32k for a model that fits comfortably", () => {
    const plan = planVllmModel({
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      artifacts: [artifact({ path: "model-00001-of-00002.safetensors" })],
      vramGb: 24,
      parameterCount: 7_615_616_512,
      contextWindow: 32_768
    });

    expect(plan.limits?.maxModelLen).toBe(32_768);
    expect(plan.extraArgs).toContain("--max-model-len");
  });

  it("still caps an advertised million-token window when the size is unknown", () => {
    const limits = planLaunchLimits({ vramGb: 24, contextWindow: 1_000_000 });

    expect(limits.maxModelLen).toBe(32_768);
    expect(limits.gpuMemoryUtilization).toBe(0.9);
    expect(limits.maxNumSeqs).toBe(4);
  });

  it("maps quantisation names to bytes per parameter", () => {
    expect(bytesPerParameter(null)).toBe(2);
    expect(bytesPerParameter("F16")).toBe(2);
    expect(bytesPerParameter("Q8_0")).toBe(1);
    expect(bytesPerParameter("IQ3_S")).toBe(0.45);
    expect(bytesPerParameter("Q4_K_M")).toBe(0.55);
    expect(bytesPerParameter("Q2_K")).toBe(0.35);
    expect(bytesPerParameter("something-else")).toBe(0.6);
  });
});
