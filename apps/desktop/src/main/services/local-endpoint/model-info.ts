import { createHash } from "node:crypto";
import { ollamaModelAlias } from "@maia/contracts";

/** Catalogue facts the endpoint can report without inspecting the instance. */
export interface ModelFacts {
  parameterCount: number | null;
  contextWindow: number | null;
  license: string | null;
  architecture: string | null;
  format: "gguf" | "safetensors" | "unknown";
}

export const UNKNOWN_FACTS: ModelFacts = {
  parameterCount: null,
  contextWindow: null,
  license: null,
  architecture: null,
  format: "unknown"
};

/** Stable per-alias digest: Ollama clients use it to detect a changed model. */
export function modelDigest(modelId: string): string {
  return `sha256:${createHash("sha256").update(modelId).digest("hex")}`;
}

/** `27_320_697_856` → `27.3B`, the string assistants show under the model name. */
export function formatParameterSize(count: number | null): string {
  if (count === null || count <= 0) {
    return "unknown";
  }

  const billions = count / 1_000_000_000;
  if (billions >= 1) {
    return `${billions.toFixed(1)}B`;
  }

  const millions = count / 1_000_000;
  return millions >= 1 ? `${millions.toFixed(0)}M` : `${Math.round(count / 1000)}K`;
}

export function modelDetails(modelId: string, facts: ModelFacts) {
  return {
    parent_model: "",
    format: facts.format,
    family: facts.architecture ?? "unknown",
    families: facts.architecture ? [facts.architecture] : [],
    parameter_size: formatParameterSize(facts.parameterCount),
    quantization_level: "unknown"
  };
}

export function tagsBody(modelId: string, facts: ModelFacts, modifiedAt: string) {
  return {
    models: [
      {
        name: ollamaModelAlias(modelId),
        model: ollamaModelAlias(modelId),
        modified_at: modifiedAt,
        size: 0,
        digest: modelDigest(modelId),
        details: modelDetails(modelId, facts)
      }
    ]
  };
}

/** Same shape as `/api/tags`, plus when the idle timer will release the GPU. */
export function psBody(
  modelId: string,
  facts: ModelFacts,
  modifiedAt: string,
  expiresAt: string,
  sizeVram: number
) {
  return {
    models: [
      {
        ...tagsBody(modelId, facts, modifiedAt).models[0],
        expires_at: expiresAt,
        size_vram: sizeVram
      }
    ]
  };
}

export function showBody(modelId: string, facts: ModelFacts, alias: string) {
  const architecture = facts.architecture;
  const modelInfo: Record<string, unknown> = {};

  if (architecture) {
    modelInfo["general.architecture"] = architecture;
    if (facts.contextWindow !== null) {
      modelInfo[`${architecture}.context_length`] = facts.contextWindow;
    }
  }
  if (facts.parameterCount !== null) {
    modelInfo["general.parameter_count"] = facts.parameterCount;
  }

  return {
    license: facts.license ?? "",
    modelfile: `# Served remotely by Maia LLM\nFROM ${modelId}\n`,
    parameters: "",
    template: "Chat template is applied by the model server that runs the weights.",
    details: modelDetails(modelId, facts),
    model_info: modelInfo,
    capabilities: ["completion"],
    modified_at: new Date().toISOString(),
    model: alias
  };
}
