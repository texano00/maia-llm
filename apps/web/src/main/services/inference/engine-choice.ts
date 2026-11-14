import type { ModelArtifact } from "@maia/contracts";

/**
 * Which engine a repository needs, judged from its weights.
 *
 * The catalogue publishes this (`supported`/`engine`), and that verdict is what the
 * product should use. But a run started from a row the backend has not judged — a
 * Hub search result, or a cached row from before the snapshot existed — had no
 * engine, and the plan defaulted to vLLM. A GGUF repository planned as vLLM boots a
 * container that opens its port and then never serves anything: the run sat in
 * "initializing" while the machine billed.
 *
 * The weights themselves answer the question, so ask them.
 */
export function engineFromArtifacts(
  artifacts: ReadonlyArray<Pick<ModelArtifact, "format" | "path">> | null | undefined
): "vllm" | "llamacpp" | null {
  if (!artifacts || artifacts.length === 0) {
    return null;
  }

  const paths = artifacts.map((artifact) => ({
    format: artifact.format,
    lower: artifact.path.toLowerCase()
  }));

  // A repository with both is a hybrid; llama.cpp serves the GGUF, and vLLM cannot
  // load the GGUF at all.
  if (paths.some((artifact) => artifact.format === "gguf" || artifact.lower.endsWith(".gguf"))) {
    return "llamacpp";
  }
  if (paths.some((artifact) => artifact.format === "safetensors" || artifact.lower.endsWith(".safetensors"))) {
    return "vllm";
  }

  return null;
}

/** A name that says GGUF and weights that do not are still a GGUF repository. */
export function engineFromName(modelId: string): "llamacpp" | null {
  return /[-_.]gguf$/i.test(modelId) ? "llamacpp" : null;
}

/** The engine to plan with: the published verdict first, then the evidence. */
export function resolveEngine(
  modelId: string,
  published: "vllm" | "llamacpp" | null | undefined,
  artifacts: ReadonlyArray<Pick<ModelArtifact, "format" | "path">> | null | undefined
): "vllm" | "llamacpp" | null {
  return published ?? engineFromName(modelId) ?? engineFromArtifacts(artifacts);
}
