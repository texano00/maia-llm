import type { CatalogueModel, ModelArtifact } from "@maia/contracts";

/** Shape returned by `GET /api/models` on huggingface.co. */
export interface HuggingFaceModelPayload {
  id: string;
  author?: string | null;
  modelId?: string;
  downloads?: number;
  likes?: number;
  gated?: boolean | "auto" | "manual";
  pipeline_tag?: string | null;
  lastModified?: string | null;
  tags?: string[];
  cardData?: { license?: string | string[]; context_length?: number } | null;
  safetensors?: { parameters?: Record<string, number> } | null;
  config?: { model_type?: string } | null;
}

export interface HuggingFaceTreeEntry {
  type: "file" | "directory";
  path: string;
  size?: number;
  lfs?: { sha256?: string; size?: number } | null;
}

const QUANTIZATION_PATTERN = /[._-](q\d+[_a-z0-9]*|iq\d+[_a-z0-9]*|fp16|bf16|f16|f32|int8|int4)(?=[._-]|$)/i;

export function mapHuggingFaceModel(
  payload: HuggingFaceModelPayload,
  cachedAt: string
): CatalogueModel {
  const id = payload.id || payload.modelId || "";
  const [authorFromId, ...rest] = id.split("/");
  const name = rest.length > 0 ? rest.join("/") : id;
  const author = payload.author ?? authorFromId ?? "unknown";
  const license = readLicense(payload);
  const parameterCount = sumParameters(payload);
  const contextWindow = readContextWindow(payload);

  return {
    id,
    author,
    name,
    license,
    pipelineTag: payload.pipeline_tag ?? null,
    parameterCount,
    contextWindow,
    downloads: payload.downloads ?? 0,
    likes: payload.likes ?? 0,
    gated: normalizeGated(payload.gated),
    lastModifiedAt: payload.lastModified ?? null,
    tags: payload.tags ?? [],
    cachedAt
  };
}

export function mapArtifacts(
  modelId: string,
  revision: string,
  entries: HuggingFaceTreeEntry[]
): ModelArtifact[] {
  return entries
    .filter((entry) => entry.type === "file")
    .map((entry) => {
      const size = entry.lfs?.size ?? entry.size ?? 0;
      return {
        id: `${modelId}@${revision}:${entry.path}`,
        modelId,
        revision,
        path: entry.path,
        format: readFormat(entry.path),
        quantization: readQuantization(entry.path),
        sizeBytes: size,
        sha256: entry.lfs?.sha256 ?? null,
        isLfs: entry.lfs != null,
        runnable: size > 0 && isRunnableWeights(entry.path)
      } satisfies ModelArtifact;
    })
    .filter((artifact) => artifact.format !== "other" || artifact.sizeBytes > 0)
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function readFormat(path: string): ModelArtifact["format"] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".safetensors")) {
    return "safetensors";
  }
  if (lower.endsWith(".gguf")) {
    return "gguf";
  }
  return "other";
}

function isRunnableWeights(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".safetensors") || lower.endsWith(".gguf");
}

function readQuantization(path: string): string | null {
  const match = QUANTIZATION_PATTERN.exec(path.toLowerCase());
  return match?.[1] ? match[1].toUpperCase() : null;
}

function normalizeGated(gated: HuggingFaceModelPayload["gated"]): CatalogueModel["gated"] {
  if (gated === "auto" || gated === "manual") {
    return gated;
  }
  return gated === true ? "manual" : "none";
}

function readLicense(payload: HuggingFaceModelPayload): string | null {
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

function readContextWindow(payload: HuggingFaceModelPayload): number | null {
  const fromCard = payload.cardData?.context_length;
  if (typeof fromCard === "number" && fromCard > 0) {
    return fromCard;
  }

  const fromName = /(\d+)[kK][-_.]?(context|ctx)/.exec(payload.id);
  if (fromName) {
    return Number(fromName[1]) * 1024;
  }

  return null;
}

function sumParameters(payload: HuggingFaceModelPayload): number | null {
  const parameters = payload.safetensors?.parameters;
  if (!parameters) {
    return null;
  }

  const total = Object.values(parameters).reduce((sum, value) => sum + value, 0);
  return Number.isFinite(total) && total > 0 ? Math.round(total) : null;
}
