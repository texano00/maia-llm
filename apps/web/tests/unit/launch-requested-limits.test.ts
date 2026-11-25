import { describe, expect, it } from "vitest";
import type { ModelArtifact } from "@maia/contracts";
import { planLaunch } from "../../src/main/services/inference/launch-plan";
import { planLaunchLimits } from "../../src/main/services/inference/model-plan";

function artifact(path: string, format: ModelArtifact["format"]): ModelArtifact {
  return {
    id: `artifact-${path}`,
    modelId: "org/model",
    revision: "main",
    path,
    format,
    quantization: format === "gguf" ? "Q4_K_M" : null,
    sizeBytes: 4_000_000_000,
    sha256: null,
    isLfs: true,
    runnable: true
  };
}

const SAFETENSORS = [artifact("model.safetensors", "safetensors")];
const GGUF = [artifact("model-Q4_K_M.gguf", "gguf")];

function argAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

describe("requested launch limits", () => {
  it("honours a context the model itself documents, above the old default", () => {
    const limits = planLaunchLimits({
      vramGb: 80,
      parameterCount: 8_000_000_000,
      quantization: "Q4_K_M",
      contextWindow: 131_072,
      requestedMaxModelLen: 131_072,
      maxConcurrentRequests: 1
    });

    expect(limits.maxModelLen).toBe(131_072);
  });

  it("keeps the product default when the person has not chosen", () => {
    const limits = planLaunchLimits({
      vramGb: 80,
      parameterCount: 8_000_000_000,
      quantization: "Q4_K_M",
      contextWindow: 131_072
    });

    expect(limits.maxModelLen).toBe(32_768);
  });

  it("never exceeds the model's documented maximum", () => {
    const limits = planLaunchLimits({
      vramGb: 80,
      parameterCount: 8_000_000_000,
      quantization: "Q4_K_M",
      contextWindow: 131_072,
      requestedMaxModelLen: 524_288,
      maxConcurrentRequests: 1
    });

    expect(limits.maxModelLen).toBe(131_072);
  });

  it("reports a requested value that does not fit instead of lowering it", () => {
    const limits = planLaunchLimits({
      vramGb: 16,
      parameterCount: 27_000_000_000,
      quantization: "Q4_K_M",
      contextWindow: 262_144,
      requestedMaxModelLen: 262_144,
      maxConcurrentRequests: 2
    });

    expect(limits.maxModelLen).toBe(262_144);
    expect(limits.fits).toBe(false);
  });

  it("shrinks the advisory per-request context as concurrency rises", () => {
    const base = {
      vramGb: 48,
      parameterCount: 8_000_000_000,
      quantization: "Q4_K_M",
      contextWindow: 131_072
    };

    const one = planLaunchLimits({
      ...base,
      maxConcurrentRequests: 1,
      concurrencyMultipliesContext: true
    });
    const four = planLaunchLimits({
      ...base,
      maxConcurrentRequests: 4,
      concurrencyMultipliesContext: true
    });

    expect(four.estimatedMaxContext).toBeLessThan(one.estimatedMaxContext);
    expect(four.maxNumSeqs).toBe(4);
  });

  it("passes the per-request context and concurrency to llama.cpp", () => {
    const plan = planLaunch({
      modelId: "org/model-GGUF",
      artifacts: GGUF,
      vramGb: 24,
      parameterCount: 8_000_000_000,
      contextWindow: 32_768,
      requestedContextWindow: 16_384,
      maxConcurrentRequests: 2
    });

    expect(plan.engine).toBe("llamacpp");
    expect(argAfter(plan.args, "-c")).toBe(String(16_384 * 2));
    expect(argAfter(plan.args, "--parallel")).toBe("2");
  });

  it("passes the per-request context and concurrency to vLLM", () => {
    const plan = planLaunch({
      modelId: "org/model",
      artifacts: SAFETENSORS,
      vramGb: 48,
      parameterCount: 8_000_000_000,
      contextWindow: 65_536,
      requestedContextWindow: 65_536,
      maxConcurrentRequests: 3
    });

    expect(plan.engine).toBe("vllm");
    expect(argAfter(plan.args, "--max-model-len")).toBe("65536");
    expect(argAfter(plan.args, "--max-num-seqs")).toBe("3");
  });
});
