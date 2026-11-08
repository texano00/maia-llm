import type { ModelArtifact } from "@maia/contracts";
import { isGgufRepositoryName } from "@maia/contracts";
import {
  baseModelCandidate,
  bytesPerParameter,
  GGUF_PLUGIN_INSTALL,
  isRootLevelPath,
  pickGgufArtifact,
  planLaunchLimits,
  planVllmModel,
  quantizationFromPath,
  type LaunchLimits
} from "./model-plan";

/**
 * Which server runs a model.
 *
 * `vllm` handles transformers checkpoints (and, historically, GGUF through an
 * out-of-tree plugin). `llamacpp` is the native GGUF runtime: it loads the
 * quantised file directly, with no plugin, no `config.json` and no engine-core
 * subprocess to die on startup.
 */
export type LaunchEngine = "vllm" | "llamacpp";

export const VLLM_IMAGE = "vllm/vllm-openai:latest";
export const LLAMACPP_IMAGE = "ghcr.io/ggml-org/llama.cpp:server-cuda";

/** What the container needs to start, independent of the host it runs on. */
export interface LaunchPlan {
  engine: LaunchEngine;
  image: string;
  /** Full server argument list, model reference included. */
  args: string[];
  /** Container environment beyond the provider's defaults. */
  env: Record<string, string>;
  /**
   * Shell commands that must run before the server starts. Only the vLLM GGUF
   * plugin needs this; the instance is then created with the SSH runtype.
   */
  onstart?: string;
  gguf: boolean;
  quantization?: string;
  limits?: LaunchLimits;
  /** Weight footprint in GB, for logs and disk decisions. */
  weightsGb: number;
}

export interface PlanLaunchInput {
  modelId: string;
  artifacts: readonly ModelArtifact[];
  /** Base repository for a GGUF mirror's tokenizer (vLLM path only). */
  tokenizer?: string | null | undefined;
  vramGb?: number | null;
  parameterCount?: number | null;
  contextWindow?: number | null;
  contextScale?: number | null;
  /** Engine the catalogue pinned for this model, when it has an opinion. */
  engine?: LaunchEngine | null | undefined;
}

const DEFAULT_CONTEXT = 32_768;
const LLAMACPP_GPU_LAYERS = "999";

/**
 * Chooses the engine, then the arguments.
 *
 * GGUF is served by llama.cpp by default: vLLM can only load it through
 * `vllm-gguf-plugin`, which installs into the image at boot and whose engine
 * core process dies with `Engine core initialization failed. Failed core
 * proc(s): {}` — a message that names neither the plugin nor the model. A mixed
 * repository (safetensors *and* GGUF) still goes to vLLM unless the catalogue
 * says otherwise.
 */
export function planLaunch(input: PlanLaunchInput): LaunchPlan {
  const hasRootSafetensors = input.artifacts.some(
    (artifact) => artifact.format === "safetensors" && isRootLevelPath(artifact.path)
  );
  const ggufArtifact = hasRootSafetensors ? null : pickGgufArtifact(input.artifacts);
  const quantization = ggufArtifact
    ? ggufArtifact.quantization ?? quantizationFromPath(ggufArtifact.path)
    : null;

  // A repository that ships root-level safetensors stays on vLLM: that is the
  // path with the most mileage. Everything else that is GGUF — by files or by
  // name, when the files are not cached yet — goes to llama.cpp.
  const engine: LaunchEngine =
    input.engine ??
    (hasRootSafetensors
      ? "vllm"
      : ggufArtifact || isGgufRepositoryName(input.modelId)
        ? "llamacpp"
        : "vllm");

  const limits =
    input.vramGb && input.vramGb > 0
      ? planLaunchLimits({
          vramGb: input.vramGb,
          parameterCount: input.parameterCount ?? null,
          quantization,
          contextWindow: input.contextWindow ?? null,
          contextScale: input.contextScale ?? null
        })
      : null;

  const weightsGb = estimateWeightsGb({
    parameterCount: input.parameterCount ?? null,
    quantization,
    vramGb: input.vramGb ?? null
  });

  if (engine === "llamacpp") {
    return planLlamaCpp({ ...input, quantization, limits, weightsGb });
  }

  const vllm = planVllmModel({
    modelId: input.modelId,
    artifacts: input.artifacts,
    tokenizer: input.tokenizer ?? null,
    vramGb: input.vramGb ?? null,
    parameterCount: input.parameterCount ?? null,
    contextWindow: input.contextWindow ?? null,
    contextScale: input.contextScale ?? null
  });

  return {
    engine: "vllm",
    image: VLLM_IMAGE,
    args: [
      "--model",
      vllm.modelArg,
      "--port",
      "8000",
      // The served name must be the catalogue id: every chat request sends it.
      "--served-model-name",
      input.modelId,
      ...vllm.extraArgs,
      // Graph capture costs startup time and the graphs matter less than
      // answering sooner; per-request logging is pure noise on a rented box.
      "--enforce-eager",
      "--disable-log-requests"
    ],
    env: vllm.env,
    ...(vllm.onstart ? { onstart: vllm.onstart } : {}),
    gguf: vllm.gguf,
    ...(vllm.quantization ? { quantization: vllm.quantization } : {}),
    ...(vllm.limits ? { limits: vllm.limits } : {}),
    weightsGb
  };
}

/**
 * llama.cpp reads the quantised file straight from the Hub.
 *
 * `-hf repo:QUANT` downloads only the shards of that quantisation, `--jinja`
 * makes it apply the model's own chat template (without it every chat request
 * is rejected), and `--alias` is what `/v1/models` reports — it has to be the
 * catalogue id for the chat client to find the model it just started.
 */
function planLlamaCpp(input: PlanLaunchInput & {
  quantization: string | null;
  limits: LaunchLimits | null;
  weightsGb: number;
}): LaunchPlan {
  const reference = input.quantization
    ? `${input.modelId}:${input.quantization}`
    : input.modelId;
  const context = input.limits?.maxModelLen ?? DEFAULT_CONTEXT;

  return {
    engine: "llamacpp",
    image: LLAMACPP_IMAGE,
    args: [
      "-hf",
      reference,
      "--host",
      "0.0.0.0",
      "--port",
      "8000",
      "--alias",
      input.modelId,
      "-c",
      String(context),
      "-ngl",
      LLAMACPP_GPU_LAYERS,
      "--jinja"
    ],
    env: {},
    gguf: true,
    ...(input.quantization ? { quantization: input.quantization } : {}),
    ...(input.limits ? { limits: input.limits } : {}),
    weightsGb: input.weightsGb
  };
}

function estimateWeightsGb(input: {
  parameterCount: number | null;
  quantization: string | null;
  vramGb: number | null;
}): number {
  if (input.parameterCount && input.parameterCount > 0) {
    return (input.parameterCount * bytesPerParameter(input.quantization)) / 1e9;
  }

  // Without a parameter count, half the card is the only honest guess.
  return (input.vramGb ?? 24) * 0.5;
}

export { GGUF_PLUGIN_INSTALL, baseModelCandidate };
