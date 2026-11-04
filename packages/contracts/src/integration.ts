import { z } from "zod";

/**
 * The loopback Ollama-compatible endpoint.
 *
 * The desktop app can re-expose the running remote model to local IDE assistants
 * (VS Code + Continue/Cline, JetBrains plugins, `ollama` CLI clients) through a
 * server bound to `127.0.0.1`. It is opt-in, never binds a routable interface and
 * disappears as soon as the session it serves is gone.
 */
export const DEFAULT_IDE_ENDPOINT_PORT = 11434;

export const integrationStatusSchema = z.object({
  /** The user's preference: keep the endpoint available while a session runs. */
  enabled: z.boolean(),
  /** The listener is actually bound (enabled *and* a session is running). */
  running: z.boolean(),
  /** A session with `state === "active"` exists. */
  sessionRunning: z.boolean(),
  /** Port actually bound; may differ from the preference after a conflict. */
  port: z.number().int().positive().nullable(),
  /** `http://127.0.0.1:<port>`, ready to paste into the assistant. */
  baseUrl: z.string().nullable(),
  /** Model alias as an Ollama client sees it: `<author>/<name>:latest`. */
  model: z.string().nullable(),
  modelId: z.string().nullable(),
  requests: z.number().int().nonnegative(),
  clients: z.number().int().nonnegative(),
  inFlight: z.number().int().nonnegative(),
  lastActivityAt: z.string().nullable(),
  /** Why the endpoint could not start (port in use, session gone, …). */
  error: z.string().nullable()
});

export const integrationEnableSchema = z.object({
  /** Preferred port; the server falls back to the next free one on a conflict. */
  port: z.number().int().min(1024).max(65_535).optional()
});

export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;
export type IntegrationEnable = z.infer<typeof integrationEnableSchema>;

/** `<author>/<name>` → `<author>/<name>:latest`, the alias Ollama clients show. */
export function ollamaModelAlias(modelId: string): string {
  return modelId.endsWith(":latest") ? modelId : `${modelId}:latest`;
}

/** Accepts the alias with or without its `:latest` tag. */
export function matchesOllamaModel(requested: string, modelId: string): boolean {
  const normalized = requested.trim().replace(/:latest$/i, "");
  return normalized === modelId;
}
