/**
 * The model record the portal publishes.
 *
 * It is the superset the desktop catalogue needs: everything the app used to
 * derive from live Hub calls, plus the two MaiaLLM-owned verdicts (engine and
 * supported) that only the backend computes. The shape is returned as-is by the
 * configs API and cached verbatim by clients.
 */

export type InferenceEngine = "vllm" | "llamacpp";

export interface CatalogArtifact {
  path: string;
  sizeBytes: number;
  format: "safetensors" | "gguf" | "other";
  quantization: string | null;
  sha256: string | null;
}

export interface CatalogModel {
  id: string;
  author: string;
  name: string;
  license: string | null;
  pipelineTag: string | null;
  parameterCount: number | null;
  contextWindow: number | null;
  downloads: number;
  likes: number;
  gated: "none" | "auto" | "manual";
  lastModifiedAt: string | null;
  tags: string[];
  capabilities: string[];
  artifacts: CatalogArtifact[];
  /** Engine that will serve the model, or null when nothing can. */
  engine: InferenceEngine | null;
  supported: boolean;
  /** Why the model is unsupported, in one sentence; null when it is. */
  supportedReason: string | null;
  /** When the snapshot that produced this record was built. */
  refreshedAt: string;
}

export interface HubSibling {
  rfilename?: string;
  size?: number;
  lfs?: { size?: number; sha256?: string } | null;
}

export interface HubModelPayload {
  id?: string;
  author?: string | null;
  downloads?: number;
  likes?: number;
  gated?: boolean | "auto" | "manual";
  pipeline_tag?: string | null;
  lastModified?: string | null;
  tags?: string[];
  library_name?: string | null;
  cardData?: { license?: string | string[]; context_length?: number } | null;
  safetensors?: { parameters?: Record<string, number> } | null;
  gguf?: { total?: number; context_length?: number; architecture?: string } | null;
  siblings?: HubSibling[];
}

const CHAT_PIPELINE_TAGS = [
  "text-generation",
  "text2text-generation",
  "image-text-to-text",
  "conversational",
  "visual-question-answering"
];

const NON_TRANSFORMERS_LIBRARIES = new Set([
  "diffusers",
  "diffusion-single-file",
  "peft",
  "timm",
  "sentence-transformers"
]);

const CAPABILITY_TAGS: Record<string, string> = {
  tools: "tools",
  "tool-use": "tools",
  "function-calling": "tools",
  vision: "vision",
  multimodal: "vision",
  image: "vision",
  code: "code",
  coding: "code",
  reasoning: "reasoning",
  thinking: "reasoning",
  multilingual: "multilingual"
};

export interface MapModelInput {
  payload: HubModelPayload;
  refreshedAt: string;
  /** The repository (or, for a GGUF mirror, its base) defines a chat template. */
  chatTemplate: boolean;
}

export function mapCatalogModel(input: MapModelInput): CatalogModel {
  const payload = input.payload;
  const id = payload.id ?? "";
  const [authorFromId, ...rest] = id.split("/");
  const files = (payload.siblings ?? []).map((sibling) => ({
    path: sibling.rfilename ?? "",
    size: sibling.lfs?.size ?? sibling.size ?? 0,
    sha256: sibling.lfs?.sha256 ?? null
  }));

  const artifacts = files
    .map((file) => ({
      path: file.path,
      sizeBytes: file.size,
      format: readFormat(file.path),
      quantization: readQuantization(file.path),
      sha256: file.sha256
    }))
    // Directories and readme blobs are noise; artifacts are weight files.
    .filter((artifact) => artifact.format !== "other" && artifact.sizeBytes > 0);

  const engine = deriveEngine(payload.library_name ?? null, files);
  const loadable = assessLoadable(payload.library_name ?? null, files);
  const contextWindow = readContextWindow(payload);
  const tags = payload.tags ?? [];

  const supportedReason = loadable.problem
    ? loadable.problem
    : engine === null
      ? "no servable weights at the repository root"
      : input.chatTemplate
        ? null
        : "the model defines no chat template, so it cannot answer chat requests";

  return {
    id,
    author: payload.author ?? authorFromId ?? "unknown",
    name: rest.length > 0 ? rest.join("/") : id,
    license: readLicense(payload),
    pipelineTag: payload.pipeline_tag ?? null,
    parameterCount: readParameterCount(payload),
    contextWindow,
    downloads: payload.downloads ?? 0,
    likes: payload.likes ?? 0,
    gated: normalizeGated(payload.gated),
    lastModifiedAt: payload.lastModified ?? null,
    tags,
    capabilities: deriveCapabilities(tags, contextWindow, payload.pipeline_tag ?? null),
    artifacts,
    engine,
    supported: supportedReason === null,
    supportedReason,
    refreshedAt: input.refreshedAt
  };
}

/**
 * GGUF weights are served by llama.cpp, safetensors by vLLM. Root-level files
 * only: `vllm serve` and `llama-server` both look at the repository root, so a
 * quant parked in a subfolder does not make the repository servable.
 */
export function deriveEngine(
  libraryName: string | null,
  files: ReadonlyArray<{ path: string }>
): InferenceEngine | null {
  if (libraryName && NON_TRANSFORMERS_LIBRARIES.has(libraryName)) {
    return null;
  }

  const root = files.filter((file) => !file.path.includes("/"));
  const hasSafetensors = root.some((file) => file.path.toLowerCase().endsWith(".safetensors"));
  const hasGguf = root.some((file) => file.path.toLowerCase().endsWith(".gguf"));

  if (hasGguf && !hasSafetensors) {
    return "llamacpp";
  }

  return hasSafetensors ? "vllm" : null;
}

/** Whether the runtime can build a model at all (config + weights present). */
export function assessLoadable(
  libraryName: string | null,
  files: ReadonlyArray<{ path: string }>
): { problem: string | null } {
  if (libraryName && NON_TRANSFORMERS_LIBRARIES.has(libraryName)) {
    return { problem: `the repository is a "${libraryName}" package, not a chat model` };
  }

  const root = files.filter((file) => !file.path.includes("/"));
  const hasSafetensors = root.some((file) => file.path.toLowerCase().endsWith(".safetensors"));
  const hasGguf = root.some((file) => file.path.toLowerCase().endsWith(".gguf"));

  if (!hasSafetensors && !hasGguf) {
    return { problem: "the repository root has no safetensors or GGUF weights" };
  }

  if (hasSafetensors && !root.some((file) => file.path === "config.json")) {
    return { problem: "the repository root has no config.json" };
  }

  return { problem: null };
}

/** `Qwen/Name-GGUF` / `Qwen/Name.gguf` → `Qwen/Name`. */
export function baseModelCandidate(modelId: string): string | null {
  if (!/[-_.]gguf$/i.test(modelId)) {
    return null;
  }

  const stripped = modelId.replace(/[-_.]gguf$/i, "");
  return stripped.includes("/") ? stripped : null;
}

export function readFormat(path: string): CatalogArtifact["format"] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".safetensors")) {
    return "safetensors";
  }
  if (lower.endsWith(".gguf")) {
    return "gguf";
  }

  return "other";
}

export function readQuantization(path: string): string | null {
  const match = /[-_.](I?Q\d+[_A-Za-z0-9]*|F16|BF16|F32)(?=\.gguf$)/i.exec(path);
  return match?.[1] ? match[1].toUpperCase() : null;
}

function readLicense(payload: HubModelPayload): string | null {
  const license = payload.cardData?.license;
  if (Array.isArray(license)) {
    return license[0] ?? null;
  }
  if (typeof license === "string") {
    return license;
  }

  const tag = payload.tags?.find((value) => value.startsWith("license:"));
  return tag ? tag.slice("license:".length) : null;
}

function readParameterCount(payload: HubModelPayload): number | null {
  const parameters = payload.safetensors?.parameters;
  if (parameters) {
    const total = Object.values(parameters).reduce((sum, value) => sum + value, 0);
    if (Number.isFinite(total) && total > 0) {
      return Math.round(total);
    }
  }

  const fromGguf = payload.gguf?.total;
  return typeof fromGguf === "number" && fromGguf > 0 ? Math.round(fromGguf) : null;
}

function readContextWindow(payload: HubModelPayload): number | null {
  const fromCard = payload.cardData?.context_length;
  if (typeof fromCard === "number" && fromCard > 0) {
    return fromCard;
  }

  const fromGguf = payload.gguf?.context_length;
  if (typeof fromGguf === "number" && fromGguf > 0) {
    return fromGguf;
  }

  const fromName = /(\d+)[kK][-_.]?(context|ctx)/.exec(payload.id ?? "");
  return fromName ? Number(fromName[1]) * 1024 : null;
}

function normalizeGated(gated: HubModelPayload["gated"]): CatalogModel["gated"] {
  if (gated === "auto" || gated === "manual") {
    return gated;
  }

  return gated === true ? "manual" : "none";
}

function deriveCapabilities(
  tags: string[],
  contextWindow: number | null,
  pipelineTag: string | null
): string[] {
  const capabilities = new Set<string>();

  if (pipelineTag === null || CHAT_PIPELINE_TAGS.includes(pipelineTag)) {
    capabilities.add("chat");
  }

  for (const tag of tags) {
    const normalized = tag.toLowerCase();
    for (const [needle, capability] of Object.entries(CAPABILITY_TAGS)) {
      if (normalized.includes(needle)) {
        capabilities.add(capability);
      }
    }
  }

  if (contextWindow !== null && contextWindow >= 32_768) {
    capabilities.add("long-context");
  }

  return [...capabilities].sort();
}
