import type { PortalCredentialStore } from "./credentials";

/** One artifact as the portal publishes it (no revision: the snapshot is one). */
export interface PortalArtifact {
  path: string;
  sizeBytes: number;
  format: "safetensors" | "gguf" | "other";
  quantization: string | null;
  sha256: string | null;
}

/**
 * The model record served by `GET /v1/config/catalogue`.
 *
 * It is the Hub facts the desktop used to compute itself, plus the two
 * backend-owned verdicts (`engine`, `supported`) that decide what the UI offers.
 */
export interface PortalCatalogueModel {
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
  artifacts: PortalArtifact[];
  engine: "vllm" | "llamacpp" | null;
  supported: boolean;
  supportedReason: string | null;
  refreshedAt: string;
}

export interface PortalCatalogue {
  snapshot: {
    version: number;
    refreshedAt: string;
    modelCount: number;
    supportedCount: number;
  };
  models: PortalCatalogueModel[];
}

export interface PortalUseCase {
  id: string;
  title: string;
  description: string;
  imageUrl: string | null;
  position: number;
  /** Ordered preference list; the client picks the first one it can run. */
  models: string[];
}

export type PortalErrorCode =
  | "not_configured"
  | "unreachable"
  | "unauthorized"
  | "unavailable"
  | "no_snapshot"
  | "invalid_payload";

export class PortalError extends Error {
  constructor(
    readonly code: PortalErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PortalError";
  }
}

interface IssuedCredentials {
  installationId: string;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

export interface PortalClientOptions {
  /** Null when the deployment never configured a portal URL. */
  baseUrl: () => string | null;
  credentials: PortalCredentialStore;
  appVersion: string;
  platform: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  logger?:
    | { info(message: string, context?: Record<string, unknown>): void; warn(message: string, context?: Record<string, unknown>): void }
    | undefined;
}

export interface PortalClient {
  /** True when a URL is configured; the catalogue then comes from the snapshot. */
  configured(): boolean;
  catalogue(): Promise<PortalCatalogue>;
  useCases(): Promise<PortalUseCase[]>;
}

const REFRESH_SKEW_MS = 60_000;

/**
 * The desktop's only door to the portal.
 *
 * Enrollment is silent and idempotent: the first catalogue read enrolls, and a
 * revoked installation simply enrolls again (the backend reactivates the same
 * row and issues a fresh credential epoch).
 */
export function createPortalClient(options: PortalClientOptions): PortalClient {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 15_000;
  /** Last body per path, so a `304 Not Modified` costs no payload. */
  const etags = new Map<string, { etag: string; body: unknown }>();

  function url(): string {
    const base = options.baseUrl()?.trim();
    if (!base) {
      throw new PortalError("not_configured", "No MaiaLLM portal URL is configured.");
    }
    return base.replace(/\/+$/, "");
  }

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(`${url()}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers as Record<string, string> | undefined)
        }
      });
    } catch (error) {
      throw new PortalError(
        "unreachable",
        `The MaiaLLM portal is unreachable: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function install(): Promise<void> {
    const response = await call("/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installId: await options.credentials.installId(),
        appVersion: options.appVersion,
        platform: options.platform
      })
    });

    if (response.status !== 201 && response.status !== 200) {
      throw new PortalError("unauthorized", `Enrollment was refused (HTTP ${response.status}).`);
    }

    const issued = (await response.json()) as IssuedCredentials;
    await options.credentials.saveCredentials(issued);
    options.logger?.info("Enrolled this installation with the MaiaLLM portal", {
      installationId: issued.installationId
    });
  }

  async function refresh(): Promise<boolean> {
    const current = await options.credentials.load();
    if (!current.refreshToken) {
      return false;
    }

    const response = await call("/v1/installations/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: current.refreshToken })
    });

    if (!response.ok) {
      // A revoked or replayed refresh token cannot be repaired: enroll again.
      await options.credentials.clearTokens();
      return false;
    }

    await options.credentials.saveCredentials((await response.json()) as IssuedCredentials);
    return true;
  }

  async function accessToken(): Promise<string> {
    const current = await options.credentials.load();
    const expiresAt = current.accessExpiresAt ? new Date(current.accessExpiresAt).getTime() : 0;
    const fresh = current.accessToken !== null && expiresAt - now().getTime() > REFRESH_SKEW_MS;

    if (fresh) {
      return current.accessToken as string;
    }

    if (current.accessToken && (await refresh())) {
      const refreshed = await options.credentials.load();
      if (refreshed.accessToken) {
        return refreshed.accessToken;
      }
    }

    await install();
    const enrolled = await options.credentials.load();
    if (!enrolled.accessToken) {
      throw new PortalError("unauthorized", "The portal issued no access token.");
    }

    return enrolled.accessToken;
  }

  async function authorized(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const token = await accessToken();
    const response = await call(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) }
    });

    if (response.status === 401 && !retried) {
      // Rotate first: a revoked access token usually still has a usable refresh
      // token, and re-enrolling is the heavier fallback.
      if (!(await refresh())) {
        await options.credentials.clearTokens();
      }
      return authorized(path, init, true);
    }

    return response;
  }

  async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const cached = etags.get(path);
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined)
    };
    if (cached) {
      headers["if-none-match"] = cached.etag;
    }

    const response = await authorized(path, { ...init, headers });

    if (response.status === 304 && cached) {
      return cached.body as T;
    }

    if (response.status === 503) {
      throw new PortalError("no_snapshot", "The portal has not published a catalogue snapshot yet.");
    }

    if (response.status === 401) {
      throw new PortalError("unauthorized", "The portal rejected this installation credential.");
    }

    if (!response.ok) {
      throw new PortalError("unavailable", `The portal answered HTTP ${response.status}.`);
    }

    const etag = response.headers.get("etag");
    let body: T;
    try {
      body = (await response.json()) as T;
    } catch {
      throw new PortalError("invalid_payload", "The portal returned a malformed response.");
    }

    if (etag) {
      etags.set(path, { etag, body });
    }

    return body;
  }

  return {
    configured: () => Boolean(options.baseUrl()?.trim()),

    catalogue: () => json<PortalCatalogue>("/v1/config/catalogue"),

    async useCases() {
      const payload = await json<{ useCases: PortalUseCase[] }>("/v1/config/use-cases");
      return payload.useCases;
    }
  };
}
