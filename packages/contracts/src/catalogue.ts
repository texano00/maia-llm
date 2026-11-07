import { z } from "zod";
import { artifactFormatSchema, gatedStatusSchema } from "./domain";

export const catalogueSortSchema = z.enum([
  "downloads",
  "likes",
  "last-modified",
  "parameters-asc",
  "parameters-desc",
  "context-desc"
]);

export const inferenceEngineSchema = z.enum(["vllm", "llamacpp"]);

/**
 * The backend's verdict on a model: which engine serves it, and if none can,
 * why. The desktop never recomputes this — it labels and filters with it.
 */
export const modelSupportSchema = z.object({
  supported: z.boolean(),
  engine: inferenceEngineSchema.nullable(),
  reason: z.string().nullable()
});

export const catalogueModelSchema = z.object({
  id: z.string().min(1),
  author: z.string().min(1),
  name: z.string().min(1),
  license: z.string().nullable(),
  pipelineTag: z.string().nullable(),
  parameterCount: z.number().int().nonnegative().nullable(),
  contextWindow: z.number().int().positive().nullable(),
  downloads: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  gated: gatedStatusSchema,
  lastModifiedAt: z.string().nullable(),
  tags: z.array(z.string()),
  /** Derived feature flags: chat, tools, vision, code, reasoning, long-context. */
  capabilities: z.array(z.string()),
  /** Backend verdict; absent on records cached from the Hub itself. */
  supported: z.boolean().nullable().optional(),
  supportedReason: z.string().nullable().optional(),
  engine: inferenceEngineSchema.nullable().optional(),
  cachedAt: z.string()
});

/**
 * Hugging Face pipeline tags that a vLLM chat server can actually serve.
 *
 * The catalogue lists the Hub, which also contains embedding, reranking, ASR and
 * image models. Renting a GPU for one of those boots fine and then rejects every
 * chat request with 404, so they are filtered out of the list and refused at
 * session start instead.
 */
export const CHAT_PIPELINE_TAGS: readonly string[] = [
  "text-generation",
  "text2text-generation",
  "image-text-to-text",
  "conversational",
  "visual-question-answering"
];

/**
 * A model can be run when its pipeline is chat-capable. `null` is allowed: some
 * Hub entries omit `pipeline_tag`, and the model card is the only other source.
 */
export function isChatCapableModel(model: { pipelineTag: string | null }): boolean {
  return model.pipelineTag === null || CHAT_PIPELINE_TAGS.includes(model.pipelineTag);
}

/**
 * `org/model-GGUF` and `org/model.gguf` are community quantisations of another
 * repository. They usually ship little but `*.gguf` shards, so facts that live
 * in the tokenizer — the chat template above all — have to be read from the
 * original repository, which is also the one vLLM borrows the tokenizer from.
 */
export function isGgufRepositoryName(id: string): boolean {
  return /[-_.]gguf$/i.test(id);
}

/**
 * True when a repository ships GGUF weights and nothing vLLM can load directly.
 *
 * GGUF is a llama.cpp format: `vllm serve <repo>` finds no `*.safetensors` and
 * dies during startup, after the instance is already billing. Repositories that
 * ship both formats stay runnable.
 *
 * Only root-level weights count. vLLM always loads the repository root, so
 * shards parked in a subfolder (`GSQ-3bit/model-00001-of-00065.safetensors`, …)
 * are invisible to it and must not make a GGUF release look like a transformers
 * checkpoint.
 */
export function isGgufOnlyRepository(
  artifacts: readonly { format: string; path?: string }[]
): boolean {
  const root = artifacts.filter((artifact) => !(artifact.path ?? "").includes("/"));
  const hasGguf = root.some((artifact) => artifact.format === "gguf");
  const hasSafetensors = root.some((artifact) => artifact.format === "safetensors");

  return hasGguf && !hasSafetensors;
}


export const modelArtifactSchema = z.object({
  id: z.string(),
  modelId: z.string(),
  revision: z.string(),
  path: z.string(),
  format: artifactFormatSchema,
  quantization: z.string().nullable(),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().nullable(),
  isLfs: z.boolean(),
  runnable: z.boolean()
});

export const catalogueQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  sort: catalogueSortSchema.optional(),
  license: z.string().trim().max(80).optional(),
  /** Feature filter, for example `tools` or `vision`. */
  capability: z.string().trim().max(40).optional(),
  gated: z.enum(["any", "open", "gated"]).optional(),
  /** Hide models the backend says nothing can serve. On by default in the UI. */
  supportedOnly: z.boolean().optional(),
  maxParameters: z.number().int().positive().optional(),
  minContextWindow: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).optional()
});

export const catalogueSnapshotInfoSchema = z.object({
  version: z.number().int().nonnegative(),
  refreshedAt: z.string(),
  /** Where the list came from: the backend snapshot or the Hub direct. */
  source: z.enum(["portal", "hub"])
});

export const catalogueResultSchema = z.object({
  models: z.array(catalogueModelSchema),
  /** True when the network refresh failed and a cached snapshot is served. */
  stale: z.boolean(),
  fetchedAt: z.string(),
  snapshot: catalogueSnapshotInfoSchema.nullable().optional()
});

export const modelDetailSchema = z.object({
  model: catalogueModelSchema,
  artifacts: z.array(modelArtifactSchema),
  /**
   * Whether the repository defines a chat template — for a GGUF mirror, whether
   * it or the repository it was quantised from does. `false` means it is a base
   * / completion model (gpt2 and friends): vLLM boots it, then rejects every
   * chat request with HTTP 400. `null` means it could not be checked.
   */
  chatTemplate: z.boolean().nullable(),
  /**
   * Whether vLLM can load the repository at all. `false` covers diffusion packs,
   * adapters and repositories without a `config.json`. `null` means unknown.
   */
  runnable: z.boolean().nullable(),
  /** One sentence explaining a `runnable: false` verdict. */
  runnableProblem: z.string().nullable(),
  licenseAccepted: z.boolean(),
  /** Present when the catalogue came from the backend snapshot. */
  support: modelSupportSchema.nullable().optional(),
  stale: z.boolean()
});

export type CatalogueSort = z.infer<typeof catalogueSortSchema>;
export type CatalogueModel = z.infer<typeof catalogueModelSchema>;
export type ModelArtifact = z.infer<typeof modelArtifactSchema>;
export type CatalogueQuery = z.infer<typeof catalogueQuerySchema>;
export type CatalogueResult = z.infer<typeof catalogueResultSchema>;
export type CatalogueSnapshotInfo = z.infer<typeof catalogueSnapshotInfoSchema>;
export type ModelDetail = z.infer<typeof modelDetailSchema>;
export type InferenceEngine = z.infer<typeof inferenceEngineSchema>;
export type ModelSupport = z.infer<typeof modelSupportSchema>;

export interface GatedAccessInfo {
  /** Short badge text next to the model name. */
  label: string;
  /** One sentence for the tooltip and the detail panel. */
  description: string;
  /** True when a human has to approve the request before downloads work. */
  requiresApproval: boolean;
}

/**
 * What "gated" means for a model.
 *
 * Hugging Face gates some repositories behind a licence that has to be accepted
 * before the files can be downloaded. `auto` approves the request instantly,
 * `manual` waits for the repository owner, and either way the download only
 * works with a Hugging Face token that has access to the repository.
 */
export function describeGatedAccess(gated: CatalogueModel["gated"]): GatedAccessInfo | null {
  switch (gated) {
    case "auto":
      return {
        label: "gated",
        description:
          "Gated model: accept its terms once on huggingface.co — approval is automatic — and Maia downloads it with your Hugging Face token.",
        requiresApproval: false
      };
    case "manual":
      return {
        label: "gated · approval",
        description:
          "Gated model: the repository owner must approve access. Request it on huggingface.co; once approved, Maia downloads it with your Hugging Face token.",
        requiresApproval: true
      };
    default:
      return null;
  }
}

/**
 * Public Hugging Face page for a repository id (`owner/name`).
 *
 * This is where the user accepts a gated model's terms or requests access, so
 * the link has to survive ids with unusual characters without breaking the path.
 */
export function huggingFaceModelUrl(modelId: string): string {
  return `https://huggingface.co/${modelId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}
