import type { HuggingFaceModelPayload, HuggingFaceTreeEntry } from "./mapper";

export interface RepositoryVerdict {
  /** `null` when the repository could not be inspected (offline, gated, 404). */
  loadable: boolean | null;
  /** One sentence explaining a negative verdict; null otherwise. */
  problem: string | null;
}

/**
 * `library_name` values that are never a text-generation transformer, even when
 * the uploader tagged the repository `text-generation`. ComfyUI packs and
 * adapters are the usual offenders: they show up in the Hub listing, rent a GPU
 * and then fail inside vLLM before the model server ever starts.
 */
const NON_LLM_LIBRARIES: Record<string, string> = {
  "diffusion-single-file": "a ComfyUI diffusion pack, not a text-generation transformer",
  diffusers: "a diffusion pipeline, not a text-generation transformer",
  peft: "an adapter (LoRA) repository, not a standalone model",
  timm: "an image-classification model, not a text-generation transformer",
  "sentence-transformers": "a sentence-embedding model",
  mlx: "an MLX-only checkpoint, which vLLM cannot load",
  onnx: "an ONNX export, which vLLM cannot load"
};

/**
 * Decides whether a repository contains something vLLM can boot.
 *
 * The Hub's `pipeline_tag` is uploader metadata and is wrong often enough to
 * matter: `Comfy-Org/MiniMax-H3` (a 4-file diffusion pack) advertises nothing,
 * and several diffusion uploads are tagged `text-generation`. What vLLM actually
 * needs is a transformers config and weights, or a GGUF file.
 */
export function assessRepository(
  model: Pick<HuggingFaceModelPayload, "library_name">,
  files: readonly HuggingFaceTreeEntry[]
): RepositoryVerdict {
  const paths = files
    .filter((file) => file.type === "file" && file.path.length > 0)
    .map((file) => file.path);
  const library = (model.library_name ?? "").toLowerCase();
  const nonLlm = NON_LLM_LIBRARIES[library];

  if (nonLlm) {
    return { loadable: false, problem: `is ${nonLlm}` };
  }

  const hasSafetensors = paths.some((path) => path.toLowerCase().endsWith(".safetensors"));
  const hasGguf = paths.some((path) => path.toLowerCase().endsWith(".gguf"));

  if (!hasSafetensors && !hasGguf) {
    return {
      loadable: false,
      problem: "ships neither .safetensors nor .gguf weights"
    };
  }

  // GGUF repositories regularly omit config.json (the loader reads the GGUF
  // metadata), but a safetensors repository without one has no architecture for
  // vLLM to build a ModelConfig from — exactly the MiniMax-H3 failure.
  if (hasSafetensors && !paths.includes("config.json")) {
    return {
      loadable: false,
      problem: "has no config.json, so vLLM cannot determine its architecture"
    };
  }

  return { loadable: true, problem: null };
}
