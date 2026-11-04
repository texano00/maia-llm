import type { ModelArtifact } from "@maia/contracts";

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
  const stripped = modelId.replace(/[-_.](gguf|GGUF)$/, "");

  return stripped !== modelId && stripped.includes("/") ? stripped : null;
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

  if (!gguf) {
    return {
      modelArg: input.modelId,
      extraArgs: [],
      env: {},
      gguf: false
    };
  }

  const quantization = gguf.quantization ?? quantizationFromPath(gguf.path);
  // The plugin's documented form is `repo:QUANT` plus a tokenizer; it derives
  // the quantisation from the suffix, so no `--quantization` flag is passed.
  const extraArgs: string[] = [];

  if (input.tokenizer) {
    extraArgs.push("--tokenizer", input.tokenizer);
  }

  return {
    modelArg: quantization ? `${input.modelId}:${quantization}` : input.modelId,
    extraArgs,
    // The plugin has to exist before `vllm serve` parses `repo:QUANT`.
    env: {},
    onstart: GGUF_PLUGIN_INSTALL,
    gguf: true,
    ...(quantization ? { quantization } : {})
  };
}

/** `model-Q4_K_M.gguf` → `Q4_K_M`. */
export function quantizationFromPath(path: string): string | null {
  const match = /[-_.](I?Q\d+[_A-Za-z0-9]*|F16|BF16|F32)(?=\.gguf$)/i.exec(path);

  return match?.[1] ? match[1].toUpperCase() : null;
}
