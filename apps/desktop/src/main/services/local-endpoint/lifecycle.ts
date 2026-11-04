import {
  DEFAULT_IDE_ENDPOINT_PORT,
  ollamaModelAlias,
  type IntegrationStatus
} from "@maia/contracts";
import type { ModelFacts } from "./model-info";
import {
  startLocalEndpoint,
  type EndpointSession,
  type LocalEndpointHandle,
  type RecordedTurn
} from "./server";

export interface LocalEndpointServiceOptions {
  appVersion: string;
  /** The session the endpoint should serve; the orchestrator's active one. */
  session(): EndpointSession | null;
  touch(sessionId: string): void;
  resolveUpstream(session: EndpointSession): { host: string; port: number } | null;
  describe(modelId: string): ModelFacts;
  recordTurn?(turn: RecordedTurn): void;
  /** Current preference, read from settings on every check. */
  preference(): { enabled: boolean; port: number };
  persist?(update: { enabled?: boolean; port?: number }): void;
  logger?: {
    info?(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
  };
  /** How often the listener is reconciled with the session state. */
  syncIntervalMs?: number;
  /** Injected in tests to keep ports deterministic. */
  portAttempts?: number;
}

/**
 * Owns the loopback listener.
 *
 * The rule from the spec is that the endpoint exists only while a session is
 * actually serving chat, so the service reconciles on a short timer: enable/disable
 * changes the preference, and every session start, end or idle release stops or
 * restarts the listener without any extra wiring in the orchestrator.
 */
export class LocalEndpointService {
  private handle: LocalEndpointHandle | null = null;
  private starting: Promise<void> | null = null;
  private lastError: string | null = null;
  private enabled: boolean;
  private preferredPort: number;
  private readonly timer: NodeJS.Timeout | null;

  constructor(private readonly options: LocalEndpointServiceOptions) {
    const preference = options.preference();
    this.enabled = preference.enabled;
    this.preferredPort = preference.port || DEFAULT_IDE_ENDPOINT_PORT;

    const interval = options.syncIntervalMs ?? 5_000;
    if (interval > 0) {
      this.timer = setInterval(() => {
        void this.sync();
      }, interval);
      this.timer.unref?.();
    } else {
      this.timer = null;
    }
  }

  status(): IntegrationStatus {
    const session = this.options.session();
    const sessionRunning = session?.state === "active";
    const metrics = this.handle?.metrics() ?? {
      requests: 0,
      clients: 0,
      inFlight: 0,
      lastActivityAt: null
    };

    return {
      enabled: this.enabled,
      running: this.handle !== null,
      sessionRunning,
      port: this.handle?.port ?? null,
      baseUrl: this.handle?.url ?? null,
      model: session && sessionRunning ? ollamaModelAlias(session.modelId) : null,
      modelId: session?.modelId ?? null,
      requests: metrics.requests,
      clients: metrics.clients,
      inFlight: metrics.inFlight,
      lastActivityAt: metrics.lastActivityAt,
      error: this.lastError
    };
  }

  async enable(port?: number): Promise<IntegrationStatus> {
    this.enabled = true;
    if (port !== undefined) {
      this.preferredPort = port;
    }
    this.options.persist?.({ enabled: true, ...(port !== undefined ? { port } : {}) });
    await this.sync();
    return this.status();
  }

  async disable(): Promise<IntegrationStatus> {
    this.enabled = false;
    this.options.persist?.({ enabled: false });
    await this.sync();
    return this.status();
  }

  /** Brings the listener in line with the preference and the session state. */
  async sync(): Promise<void> {
    if (!this.enabled) {
      await this.stop();
      return;
    }

    const session = this.options.session();
    if (!session || session.state !== "active") {
      await this.stop();
      return;
    }

    if (this.handle && this.handle.port === this.preferredPort) {
      return;
    }

    if (this.handle) {
      // The preferred port changed: rebind rather than keep the old one.
      await this.stop();
    }

    await this.start();
  }

  async dispose(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.stop();
  }

  private async start(): Promise<void> {
    if (this.starting) {
      return this.starting;
    }

    this.starting = (async () => {
      try {
        this.handle = await startLocalEndpoint({
          port: this.preferredPort,
          appVersion: this.options.appVersion,
          session: () => this.options.session(),
          touch: (sessionId) => this.options.touch(sessionId),
          resolveUpstream: (session) => this.options.resolveUpstream(session),
          describe: (modelId) => this.options.describe(modelId),
          ...(this.options.recordTurn ? { recordTurn: this.options.recordTurn } : {}),
          ...(this.options.logger ? { logger: this.options.logger } : {}),
          ...(this.options.portAttempts !== undefined
            ? { portAttempts: this.options.portAttempts }
            : {})
        });
        this.lastError = null;
        this.options.logger?.info?.("IDE endpoint listening", {
          url: this.handle.url,
          model: this.options.session()?.modelId
        });
      } catch (error) {
        this.handle = null;
        this.lastError =
          error instanceof Error ? error.message : "the IDE endpoint could not start";
        this.options.logger?.warn("IDE endpoint could not start", {
          message: this.lastError
        });
      } finally {
        this.starting = null;
      }
    })();

    return this.starting;
  }

  private async stop(): Promise<void> {
    const handle = this.handle;
    this.handle = null;

    if (!handle) {
      return;
    }

    try {
      await handle.close();
      this.options.logger?.info?.("IDE endpoint stopped");
    } catch (error) {
      this.options.logger?.warn("IDE endpoint could not be stopped cleanly", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
