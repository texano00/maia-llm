import { isGgufRepositoryName, type ModelArtifact } from "@maia/contracts";

/**
 * Quantisations to try, best first. Q4_K_M is the usual sweet spot — small
 * enough to fit a 24 GB card and good enough to keep the model coherent — and
 * the rest are picked when a repository ships only one of them.
 */
export const GGUF_QUANT_PREFERENCE: readonly string[] = [
  "Q4_K_M",
  "Q5_K_M",
  "Q4_K_S",
  "Q5_K_S",
  "Q6_K",
  "Q8_0",
  "Q4_0",
  "Q3_K_M",
  "Q2_K",
  "F16",
  "BF16"
];

/** How a model is handed to `vllm serve`, plus what the container needs first. */
export interface VllmModelPlan {
  /** Value for `--model`: `repo` for safetensors, `repo:QUANT` for GGUF. */
  modelArg: string;
  /** Extra vLLM arguments (tokenizer, quantization…). */
  extraArgs: string[];
  /** Extra container environment. */
  env: Record<string, string>;
  /** Commands run inside the container before the server starts. */
  onstart?: string;
  /** True when the weights are GGUF and the loader plugin has to be installed. */
  gguf: boolean;
  /** Quantisation chosen for a GGUF repository, for logs. */
  quantization?: string;
  /** Memory-aware limits derived from the chosen GPU, for logs. */
  limits?: LaunchLimits;
}

/** Context/parallelism the launch is allowed to use on the chosen card. */
export interface LaunchLimits {
  maxModelLen: number;
  gpuMemoryUtilization: number;
  maxNumSeqs: number;
}

const DEFAULT_CONTEXT_LIMIT = 32_768;
const MIN_CONTEXT_LIMIT = 4_096;
/** CUDA context, activations and the loader need room that is not KV cache. */
const RESERVE_GB = 1.5;
const GPU_MEMORY_UTILIZATION = 0.9;
const MAX_NUM_SEQS = 4;
/**
 * KV cache growth per parameter per token, in GB.
 *
 * Derived from dense GQA models (~96 KB/token at 8B parameters) and kept on the
 * generous side: an over-estimate shortens the context, an under-estimate makes
 * the engine core die at startup.
 */
const KV_GB_PER_PARAMETER_TOKEN = 1.2e-14;

/** Bytes each weight occupies, from the quantisation in the file name. */
export function bytesPerParameter(quantization: string | null | undefined): number {
  if (!quantization) {
    // Safetensors checkpoints are served in their stored dtype, usually BF16.
    return 2;
  }

  const quant = quantization.toUpperCase();
  if (quant.startsWith("IQ1") || quant.startsWith("Q1")) {
    return 0.25;
  }
  if (quant.startsWith("IQ2") || quant.startsWith("Q2")) {
    return 0.35;
  }
  if (quant.startsWith("IQ3") || quant.startsWith("Q3")) {
    return 0.45;
  }
  if (quant.startsWith("IQ4") || quant.startsWith("Q4")) {
    return 0.55;
  }
  if (quant.startsWith("Q5")) {
    return 0.7;
  }
  if (quant.startsWith("Q6")) {
    return 0.8;
  }
  if (quant.startsWith("Q8") || quant.startsWith("IQ8")) {
    return 1;
  }
  if (quant.startsWith("F32")) {
    return 4;
  }
  if (quant.startsWith("F16") || quant.startsWith("BF16")) {
    return 2;
  }

  return 0.6;
}

/**
 * Decides how much context vLLM may reserve on this card.
 *
 * vLLM defaults `--max-model-len` to the model's advertised context. A 27B GGUF
 * that claims 262 144 tokens therefore asks for a KV cache of dozens of GB on a
 * 24 GB card, and the *engine core process* is killed while initialising — the
 * launcher only reports `Engine core initialization failed`, with the real
 * `OutOfMemoryError` above it in a log nobody reads. Sizing the request to the
 * GPU up front is what makes that boot succeed.
 */
export function planLaunchLimits(input: {
  vramGb: number;
  parameterCount?: number | null;
  quantization?: string | null;
  contextWindow?: number | null;
}): LaunchLimits {
  const advertised =
    input.contextWindow && input.contextWindow > 0 ? input.contextWindow : DEFAULT_CONTEXT_LIMIT;
  // Never ask for more than 32k: past that, KV cache dominates and the model
  // answers no better for the price. Smaller advertised windows are respected.
  const desired = Math.max(MIN_CONTEXT_LIMIT, Math.min(advertised, DEFAULT_CONTEXT_LIMIT));

  const parameters = input.parameterCount && input.parameterCount > 0 ? input.parameterCount : null;
  const weightsGb = parameters
    ? (parameters * bytesPerParameter(input.quantization)) / 1e9
    : input.vramGb * 0.5;
  const availableGb = Math.max(
    0,
    input.vramGb * GPU_MEMORY_UTILIZATION - weightsGb - RESERVE_GB
  );

  const kvPerTokenGb = parameters ? parameters * KV_GB_PER_PARAMETER_TOKEN : null;
  const fitting = kvPerTokenGb ? Math.floor(availableGb / kvPerTokenGb / 1_024) * 1_024 : 0;

  const maxModelLen =
    fitting > 0 ? Math.min(desired, Math.max(MIN_CONTEXT_LIMIT, fitting)) : desired;

  return {
    maxModelLen,
    gpuMemoryUtilization: GPU_MEMORY_UTILIZATION,
    maxNumSeqs: MAX_NUM_SEQS
  };
}

/** The vLLM flags that carry a `LaunchLimits` object. */
export function launchLimitArgs(limits: LaunchLimits | null): string[] {
  if (!limits) {
    return [];
  }

  return [
    "--max-model-len",
    String(limits.maxModelLen),
    "--gpu-memory-utilization",
    limits.gpuMemoryUtilization.toFixed(2),
    "--max-num-seqs",
    String(limits.maxNumSeqs)
  ];
}

/**
 * Installs vLLM's out-of-tree GGUF loader. The official API image does not ship
 * it, and `vllm serve` refuses `repo:QUANT` without it; `uv` is present in the
 * vLLM image, pip is the fallback.
 *
 * This is a **shell script**: the instance must be created with Vast's SSH
 * runtype, where `onstart` is executed by a shell. With `runtype: "args"` the
 * whole string becomes the container command and Docker fails with
 * `exec: "uv pip install …": executable file not found in $PATH`.
 */
export const GGUF_PLUGIN_INSTALL =
  "uv pip install --system vllm-gguf-plugin || python3 -m pip install vllm-gguf-plugin";

/** `huihui-ai/X-27B-abliterated-GGUF` → `huihui-ai/X-27B-abliterated`. */
export function baseModelCandidate(modelId: string): string | null {
  if (!isGgufRepositoryName(modelId)) {
    return null;
  }

  const stripped = modelId.replace(/[-_.]gguf$/i, "");

  return stripped.includes("/") ? stripped : null;
}

/**
 * vLLM loads the repository root: `vllm serve org/model` resolves `config.json`
 * and the weight index there, never inside `subfolder/`.
 */
export function isRootLevelPath(path: string): boolean {
  return !path.includes("/");
}

/**
 * GGUF files that sit next to a checkpoint without being one: MTP draft heads
 * (`RVN-Q4_K_M-mtp.gguf`), vision projectors (`mmproj-*.gguf`) and multimodal
 * variants. Serving them produces a broken model even though the file parses.
 */
export function isAuxiliaryGguf(path: string): boolean {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";

  return (
    name.startsWith("mmproj-") ||
    name.endsWith("-mtp.gguf") ||
    name.endsWith("-vision.gguf")
  );
}

function pickGgufArtifact(artifacts: readonly ModelArtifact[]): ModelArtifact | null {
  const gguf = artifacts.filter(
    (artifact) =>
      artifact.format === "gguf" &&
      artifact.sizeBytes > 0 &&
      artifact.runnable !== false &&
      isRootLevelPath(artifact.path) &&
      !isAuxiliaryGguf(artifact.path)
  );

  if (gguf.length === 0) {
    return null;
  }

  for (const quant of GGUF_QUANT_PREFERENCE) {
    const match = gguf.find(
      (artifact) =>
        (artifact.quantization ?? "").toUpperCase() === quant ||
        artifact.path.toUpperCase().includes(quant)
    );

    if (match) {
      return match;
    }
  }

  return gguf[0] ?? null;
}

export interface PlanVllmModelInput {
  modelId: string;
  artifacts: readonly ModelArtifact[];
  /**
   * Base repository to borrow the tokenizer from, when it exists. Omitted for
   * repositories without a `-GGUF` sibling, and for safetensors models.
   */
  tokenizer?: string | null | undefined;
  /** VRAM of the GPU the offer was made for; enables memory-aware limits. */
  vramGb?: number | null;
  parameterCount?: number | null;
  contextWindow?: number | null;
}

/**
 * Decides how to launch a model on vLLM.
 *
 * Safetensors repositories need nothing special. GGUF repositories are served
 * through vLLM's GGUF plugin using the documented `repo:QUANT` form, with the
 * original (non-GGUF) repository as tokenizer when it exists — vLLM's own docs
 * recommend that over converting the tokenizer out of the GGUF metadata.
 */
export function planVllmModel(input: PlanVllmModelInput): VllmModelPlan {
  // Shards in a subfolder do not make the repository a transformers checkpoint:
  // `vllm serve <repo>` would find no config.json or index at the root.
  const safetensors = input.artifacts.some(
    (artifact) => artifact.format === "safetensors" && isRootLevelPath(artifact.path)
  );
  const gguf = safetensors ? null : pickGgufArtifact(input.artifacts);
  const quantization = gguf ? gguf.quantization ?? quantizationFromPath(gguf.path) : null;

  const limits =
    input.vramGb && input.vramGb > 0
      ? planLaunchLimits({
          vramGb: input.vramGb,
          parameterCount: input.parameterCount ?? null,
          quantization,
          contextWindow: input.contextWindow ?? null
        })
      : null;
  const limitArgs = launchLimitArgs(limits);

  if (!gguf) {
    return {
      modelArg: input.modelId,
      extraArgs: limitArgs,
      env: {},
      gguf: false,
      ...(limits ? { limits } : {})
    };
  }

  // The plugin's documented form is `repo:QUANT` plus a tokenizer; it derives
  // the quantisation from the suffix, so no `--quantization` flag is passed.
  const extraArgs: string[] = [];

  if (input.tokenizer) {
    extraArgs.push("--tokenizer", input.tokenizer);
  }
  extraArgs.push(...limitArgs);

  return {
    modelArg: quantization ? `${input.modelId}:${quantization}` : input.modelId,
    extraArgs,
    // The plugin has to exist before `vllm serve` parses `repo:QUANT`.
    env: {},
    onstart: GGUF_PLUGIN_INSTALL,
    gguf: true,
    ...(quantization ? { quantization } : {}),
    ...(limits ? { limits } : {})
  };
}

/** `model-Q4_K_M.gguf` → `Q4_K_M`. */
export function quantizationFromPath(path: string): string | null {
  const match = /[-_.](I?Q\d+[_A-Za-z0-9]*|F16|BF16|F32)(?=\.gguf$)/i.exec(path);

  return match?.[1] ? match[1].toUpperCase() : null;
}
