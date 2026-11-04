import type { ServerResponse } from "node:http";

/** Writes a JSON body with an explicit length, so clients do not hang on writes. */
export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers
  });
  response.end(payload);
}

/**
 * Ollama-shaped error: `{ "error": "…" }`, plus `retryable` when the client
 * should try again shortly (provisioning, queued).
 */
export function sendError(
  response: ServerResponse,
  status: number,
  message: string,
  options: { retryable?: boolean; headers?: Record<string, string> } = {}
): void {
  const body = options.retryable ? { error: message, retryable: true } : { error: message };
  sendJson(response, status, body, options.headers ?? {});
}

/** An option the client sent that this endpoint cannot honour. */
export class InvalidOptionError extends Error {}

/** The upstream vLLM server refused the request. */
export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
