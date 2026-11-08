import { describe, expect, it } from "vitest";
import type { ModelArtifact } from "@maia/contracts";
import { LLAMACPP_IMAGE, planLaunch, VLLM_IMAGE } from "../../src/main/services/inference/launch-plan";

const MODEL_ID = "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF";

function artifact(
  path: string,
  format: ModelArtifact["format"],
  quantization: string | null = null
): ModelArtifact {
  return {
    id: `${MODEL_ID}@main:${path}`,
    modelId: MODEL_ID,
    revision: "main",
    path,
    format,
    quantization,
    sizeBytes: 16_000_000_000,
    sha256: null,
    isLfs: true,
    runnable: true
  };
}

const ggufShards = [
  artifact("Huihui-Qwen3.8-27B-Q4_K_M-00001-of-00002.gguf", "gguf", "Q4_K_M"),
  artifact("Huihui-Qwen3.8-27B-Q4_K_M-00002-of-00002.gguf", "gguf", "Q4_K_M")
];

const safetensors = [
  artifact("model-00001-of-00004.safetensors", "safetensors"),
  artifact("model-00002-of-00004.safetensors", "safetensors")
];

describe("launch planning", () => {
  it("runs a GGUF-only repository on llama.cpp, not on the vLLM plugin", () => {
    const plan = planLaunch({
      modelId: MODEL_ID,
      artifacts: ggufShards,
      vramGb: 96,
      parameterCount: 27_300_000_000,
      contextWindow: 262_144
    });

    expect(plan.engine).toBe("llamacpp");
    expect(plan.image).toBe(LLAMACPP_IMAGE);
    expect(plan.args).toEqual([
      "-hf",
      `${MODEL_ID}:Q4_K_M`,
      "--host",
      "0.0.0.0",
      "--port",
      "8000",
      "--alias",
      MODEL_ID,
      "-c",
      String(plan.limits?.maxModelLen),
      "-ngl",
      "999",
      "--jinja"
    ]);
    // No `--model`, no tokenizer borrow, no plugin install: llama.cpp reads the
    // quantised file itself.
    expect(plan.args).not.toContain("--model");
    expect(plan.args).not.toContain("--tokenizer");
    expect(plan.onstart).toBeUndefined();
    expect(plan.gguf).toBe(true);
    expect(plan.quantization).toBe("Q4_K_M");
  });

  it("sizes the context to the card instead of trusting the advertised window", () => {
    const plan = planLaunch({
      modelId: MODEL_ID,
      artifacts: ggufShards,
      vramGb: 24,
      parameterCount: 27_300_000_000,
      contextWindow: 262_144
    });

    expect(plan.limits?.maxModelLen).toBeLessThan(262_144);
    expect(plan.limits?.maxModelLen).toBeGreaterThanOrEqual(4_096);
    expect(plan.args).toContain(String(plan.limits?.maxModelLen));
  });

  it("keeps transformers checkpoints on vLLM", () => {
    const plan = planLaunch({
      modelId: "Qwen/Qwen3-14B",
      artifacts: safetensors,
      vramGb: 48,
      parameterCount: 14_000_000_000,
      contextWindow: 32_768
    });

    expect(plan.engine).toBe("vllm");
    expect(plan.image).toBe(VLLM_IMAGE);
    expect(plan.args.slice(0, 2)).toEqual(["--model", "Qwen/Qwen3-14B"]);
    expect(plan.args).toContain("--served-model-name");
    expect(plan.args).toContain("--max-model-len");
    expect(plan.onstart).toBeUndefined();
  });

  it("lets the catalogue pin the engine for a repository that ships both formats", () => {
    const mixed = [...safetensors, ...ggufShards];

    expect(planLaunch({ modelId: MODEL_ID, artifacts: mixed, vramGb: 24 }).engine).toBe("vllm");
    expect(
      planLaunch({ modelId: MODEL_ID, artifacts: mixed, vramGb: 24, engine: "llamacpp" }).engine
    ).toBe("llamacpp");
  });

  it("honours a llama.cpp pin even before the files are known", () => {
    const plan = planLaunch({
      modelId: MODEL_ID,
      artifacts: [],
      vramGb: 24,
      engine: "llamacpp"
    });

    expect(plan.engine).toBe("llamacpp");
    // Without a detected quantisation the repository is passed as-is; llama.cpp
    // picks its default file.
    expect(plan.args).toContain(MODEL_ID);
    expect(plan.args.some((arg) => arg.includes(":"))).toBe(false);
  });

  it("shrinks the context on a retry after a memory failure", () => {
    const full = planLaunch({
      modelId: MODEL_ID,
      artifacts: ggufShards,
      vramGb: 48,
      parameterCount: 27_300_000_000,
      contextWindow: 262_144
    });
    const retry = planLaunch({
      modelId: MODEL_ID,
      artifacts: ggufShards,
      vramGb: 48,
      parameterCount: 27_300_000_000,
      contextWindow: 262_144,
      contextScale: 0.5
    });

    expect(retry.limits?.maxModelLen).toBeLessThan(full.limits?.maxModelLen ?? 0);
  });
});
