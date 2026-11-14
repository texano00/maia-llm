import {
  appSettingsSchema,
  configurationDocumentVersion,
  importDocumentSchema,
  type AppSettings,
  type ConfigurationDocument,
  type ConfigurationScope,
  type CredentialPresence,
  type ImportDocument,
  type SettingsUpdate
} from "@maia/contracts";
import { accessError } from "../accounts/errors";

/** A settings document is a few kilobytes; anything near this is abuse. */
export const MAX_DOCUMENT_BYTES = 64 * 1024;

export interface ImportPlan {
  patch: SettingsUpdate;
  applied: string[];
  skipped: Array<{ path: string; reason: "unknown" | "invalid" | "unsupported" }>;
}

/**
 * Builds the document the settings screen and a person's own tooling both read.
 * Only presence and verification state of provider keys is included: no code
 * path here can reach a secret.
 */
export function buildConfigurationDocument(
  settings: AppSettings,
  credentials: CredentialPresence[],
  now: Date = new Date()
): ConfigurationDocument {
  return {
    version: configurationDocumentVersion,
    exportedAt: now.toISOString(),
    settings,
    credentials
  };
}

/** Validates a document before any write happens. */
export function parseImportDocument(raw: unknown): ImportDocument {
  const size = JSON.stringify(raw ?? null).length;
  if (size > MAX_DOCUMENT_BYTES) {
    throw accessError("VALIDATION_FAILED", "That configuration file is too large.");
  }

  const parsed = importDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    throw accessError(
      "VALIDATION_FAILED",
      "That file is not a configuration this version can import."
    );
  }

  return parsed.data;
}

/**
 * What an import would change. Best effort by design: a single bad value does
 * not throw away the rest of the file, and it never touches credentials.
 */
export function planImport(
  current: AppSettings,
  document: Pick<ImportDocument, "settings">
): ImportPlan {
  const shape = appSettingsSchema.shape as Record<string, { safeParse(value: unknown): { success: boolean; data?: unknown } }>;
  const patch: SettingsUpdate = {};
  const applied: string[] = [];
  const skipped: ImportPlan["skipped"] = [];

  for (const [key, value] of Object.entries(document.settings)) {
    const field = shape[key];
    if (!field) {
      skipped.push({ path: `settings.${key}`, reason: "unknown" });
      continue;
    }

    const parsed = field.safeParse(value);
    if (!parsed.success) {
      skipped.push({ path: `settings.${key}`, reason: "invalid" });
      continue;
    }

    const next = parsed.data;
    const before = (current as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(before) === JSON.stringify(next)) {
      continue;
    }

    (patch as unknown as Record<string, unknown>)[key] = next;
    applied.push(`settings.${key}`);
  }

  return { patch, applied, skipped };
}

/** Which settings fields a scope resets, for the confirmation copy and tests. */
export const RESET_SCOPES: ConfigurationScope[] = [
  "all",
  "appearance",
  "catalogue",
  "chat",
  "gpu",
  "telemetry",
  "onboarding",
  "credentials"
];
