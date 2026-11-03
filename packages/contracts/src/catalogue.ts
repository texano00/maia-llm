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
  cachedAt: z.string()
});

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
  maxParameters: z.number().int().positive().optional(),
  minContextWindow: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).optional()
});

export const catalogueResultSchema = z.object({
  models: z.array(catalogueModelSchema),
  /** True when the network refresh failed and a cached snapshot is served. */
  stale: z.boolean(),
  fetchedAt: z.string()
});

export const modelDetailSchema = z.object({
  model: catalogueModelSchema,
  artifacts: z.array(modelArtifactSchema),
  licenseAccepted: z.boolean(),
  stale: z.boolean()
});

export type CatalogueSort = z.infer<typeof catalogueSortSchema>;
export type CatalogueModel = z.infer<typeof catalogueModelSchema>;
export type ModelArtifact = z.infer<typeof modelArtifactSchema>;
export type CatalogueQuery = z.infer<typeof catalogueQuerySchema>;
export type CatalogueResult = z.infer<typeof catalogueResultSchema>;
export type ModelDetail = z.infer<typeof modelDetailSchema>;
