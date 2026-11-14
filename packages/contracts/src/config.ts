import { z } from "zod";
import { appSettingsSchema } from "./ipc";

/**
 * The portable configuration document (specs/006-theme-and-user-config).
 *
 * One shape is used for "read my configuration" and "export it": the person's
 * own tooling and the settings screen must see byte-identical content. A
 * document can never contain provider secret material — `credentials` reports
 * presence and verification only.
 */

export const configurationDocumentVersion = 1;

export const credentialPresenceSchema = z.object({
  provider: z.enum(["huggingface", "vastai", "s3"]),
  saved: z.boolean(),
  status: z.enum(["valid", "invalid", "unknown"]),
  lastVerifiedAt: z.string().nullable()
});

export const configurationDocumentSchema = z.object({
  version: z.literal(configurationDocumentVersion),
  exportedAt: z.string().min(1),
  settings: appSettingsSchema,
  credentials: z.array(credentialPresenceSchema).max(3)
});

/**
 * An imported document keeps its settings as written: unknown keys have to reach
 * the importer so they can be reported instead of silently vanishing.
 */
export const importDocumentSchema = z.object({
  version: z.literal(configurationDocumentVersion),
  exportedAt: z.string().min(1),
  settings: z.record(z.string(), z.unknown()),
  credentials: z.array(credentialPresenceSchema).max(3)
});

export const configurationScopeSchema = z.enum([
  "all",
  "appearance",
  "catalogue",
  "chat",
  "gpu",
  "telemetry",
  "onboarding",
  "credentials"
]);

export const configImportSchema = z.object({
  document: importDocumentSchema,
  /** Typed deliberately: an import replaces the values the person can see. */
  confirm: z.literal(true)
});

export const configResetSchema = z.object({
  scope: configurationScopeSchema,
  confirm: z.literal(true)
});

export const configImportResultSchema = z.object({
  settings: appSettingsSchema,
  applied: z.array(z.string()),
  skipped: z.array(
    z.object({
      path: z.string(),
      reason: z.enum(["unknown", "invalid", "unsupported"])
    })
  )
});

export const configResetResultSchema = z.object({
  settings: appSettingsSchema,
  credentialsCleared: z.boolean()
});

export type ConfigurationDocument = z.infer<typeof configurationDocumentSchema>;
export type ImportDocument = z.infer<typeof importDocumentSchema>;
export type ConfigurationScope = z.infer<typeof configurationScopeSchema>;
export type CredentialPresence = z.infer<typeof credentialPresenceSchema>;
export type ConfigImport = z.infer<typeof configImportSchema>;
export type ConfigReset = z.infer<typeof configResetSchema>;
export type ConfigImportResult = z.infer<typeof configImportResultSchema>;
export type ConfigResetResult = z.infer<typeof configResetResultSchema>;
