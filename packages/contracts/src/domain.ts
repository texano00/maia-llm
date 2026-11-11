import { z } from "zod";

export const sessionStateSchema = z.enum([
  "estimated",
  "provisioning",
  "ready",
  "active",
  "ending",
  "ended",
  "cancelled",
  "failed"
]);

export const inferenceRuntimeSchema = z.enum(["vllm", "llamacpp"]);

/**
 * What the model can do. `text` keeps its historical meaning, so existing
 * sessions and callers need no migration.
 */
export const modelCapabilitySchema = z.enum([
  "text",
  "text-to-image",
  "image-to-text",
  "image-to-image"
]);

/** Compute power the user picks in the catalogue popup. */
export const powerTierSchema = z.enum(["economy", "balanced", "performance"]);

export const conversationOriginSchema = z.enum(["app", "ide"]);

export const messageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

export const backupStatusSchema = z.enum([
  "queued",
  "validating",
  "uploading",
  "paused",
  "verifying",
  "completed",
  "failed",
  "broken"
]);

export const backupUploadStatusSchema = z.enum([
  "pending",
  "uploading",
  "stored",
  "failed"
]);

export const providerSchema = z.enum(["huggingface", "vastai", "s3"]);

export const releaseChannelSchema = z.enum(["stable", "beta"]);

export const providerModeSchema = z.enum(["live", "mock"]);

export const gatedStatusSchema = z.enum(["none", "auto", "manual"]);

export const artifactFormatSchema = z.enum(["safetensors", "gguf", "other"]);

export type SessionState = z.infer<typeof sessionStateSchema>;
export type InferenceRuntime = z.infer<typeof inferenceRuntimeSchema>;
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export type PowerTier = z.infer<typeof powerTierSchema>;
export type ConversationOrigin = z.infer<typeof conversationOriginSchema>;
export type MessageRole = z.infer<typeof messageRoleSchema>;
export type BackupStatus = z.infer<typeof backupStatusSchema>;
export type BackupUploadStatus = z.infer<typeof backupUploadStatusSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type ReleaseChannel = z.infer<typeof releaseChannelSchema>;
export type ProviderMode = z.infer<typeof providerModeSchema>;
