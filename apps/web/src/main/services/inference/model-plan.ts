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
  /** Per-request context window. */
  maxModelLen: number;
  gpuMemoryUtilization: number;
  maxNumSeqs: number;
  /** Requests the server handles at once (the person's choice, clamped). */
  maxConcurrentRequests: number;
  /** Largest per-request context this card can hold at that concurrency. */
  estimatedMaxContext: number;
  /** True when the requested context is at or below the estimate. */
  fits: boolean;
}

const DEFAULT_CONTEXT_LIMIT = 32_768;
const MIN_CONTEXT_LIMIT = 4_096;
/** CUDA context, activations and the loader need room that is not KV cache. */
const RESERVE_GB = 1.5;
const GPU_MEMORY_UTILIZATION = 0.9;
/** vLLM's historical default, kept as the run's starting concurrency. */
export const DEFAULT_VLLM_MAX_SEQS = 4;
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
  /**
   * A value the person chose. It is clamped only by what the model documents,
   * never by the product's default: a silent reduction is what FR-009 forbids.
   */
  requestedMaxModelLen?: number | null;
  /** Requests handled at once; defaults to one so old callers keep their shape. */
  maxConcurrentRequests?: number | null;
  /**
   * True when concurrency splits one context budget (llama.cpp's `-c` is the
   * total across `--parallel` slots). vLLM draws every slot from one cache pool.
   */
  concurrencyMultipliesContext?: boolean;
  /**
   * Multiplier applied after a memory failure, so the retry asks for less
   * instead of repeating the same crash on another host.
   */
  contextScale?: number | null;
}): LaunchLimits {
  const advertised =
    input.contextWindow && input.contextWindow > 0 ? input.contextWindow : DEFAULT_CONTEXT_LIMIT;
  const requested =
    input.requestedMaxModelLen && input.requestedMaxModelLen > 0
      ? input.requestedMaxModelLen
      : null;
  // The model's own maximum is the ceiling; the product's 32k stays the default.
  const desired = requested
    ? Math.max(MIN_CONTEXT_LIMIT, Math.min(requested, advertised))
    : Math.max(MIN_CONTEXT_LIMIT, Math.min(advertised, DEFAULT_CONTEXT_LIMIT));

  const concurrency = Math.min(
    8,
    Math.max(1, Math.round(input.maxConcurrentRequests ?? DEFAULT_VLLM_MAX_SEQS))
  );
  const parameters = input.parameterCount && input.parameterCount > 0 ? input.parameterCount : null;
  const weightsGb = parameters
    ? (parameters * bytesPerParameter(input.quantization)) / 1e9
    : input.vramGb * 0.5;
  const availableGb = Math.max(
    0,
    input.vramGb * GPU_MEMORY_UTILIZATION - weightsGb - RESERVE_GB
  );

  const kvPerTokenGb = parameters ? parameters * KV_GB_PER_PARAMETER_TOKEN : null;
  // Total tokens the card can hold across every concurrent request.
  const totalCapacityTokens = kvPerTokenGb ? Math.floor(availableGb / kvPerTokenGb) : null;
  const slots = input.concurrencyMultipliesContext === true ? concurrency : 1;
  const estimatedMaxContext =
    totalCapacityTokens === null
      ? desired
      : Math.max(
          MIN_CONTEXT_LIMIT,
          Math.floor(totalCapacityTokens / slots / 1_024) * 1_024
        );

  // The default shrinks to what fits; an explicit request is honoured so the
  // person sees the consequence rather than a silently smaller number.
  const fitted = requested
    ? desired
    : Math.min(desired, Math.max(MIN_CONTEXT_LIMIT, estimatedMaxContext));

  const scale = input.contextScale;
  const maxModelLen =
    scale !== undefined && scale !== null && scale > 0 && scale < 1
      ? Math.max(MIN_CONTEXT_LIMIT, Math.floor((fitted * scale) / 1_024) * 1_024)
      : fitted;

  return {
    maxModelLen,
    gpuMemoryUtilization: GPU_MEMORY_UTILIZATION,
    maxNumSeqs: concurrency,
    maxConcurrentRequests: concurrency,
    estimatedMaxContext,
    fits: maxModelLen <= estimatedMaxContext
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

export function pickGgufArtifact(artifacts: readonly ModelArtifact[]): ModelArtifact | null {
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
  /** The person's explicit per-request context, when they changed it. */
  requestedContextWindow?: number | null;
  /** Requests handled at once; defaults to vLLM's historical 4. */
  maxConcurrentRequests?: number | null;
  /**
   * True when concurrency splits one context budget (llama.cpp's `-c` is the
   * total across `--parallel` slots). vLLM draws every slot from one cache pool,
   * so its per-request context does not shrink as concurrency rises.
   */
  concurrencyMultipliesContext?: boolean;
  /** Shrinks the context on a retry after a memory failure (0 < scale < 1). */
  contextScale?: number | null;
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
          contextWindow: input.contextWindow ?? null,
          requestedMaxModelLen: input.requestedContextWindow ?? null,
          maxConcurrentRequests: input.maxConcurrentRequests ?? DEFAULT_VLLM_MAX_SEQS,
          contextScale: input.contextScale ?? null
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
