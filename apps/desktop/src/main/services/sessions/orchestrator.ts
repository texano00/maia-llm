import { randomUUID } from "node:crypto";
import type { Estimate, GpuFilters, Session, SessionStart } from "@maia/contracts";
import { buildEstimate } from "../cost/estimator";
import type { SessionStore } from "./store";

export type StreamKind = "content" | "reasoning";

export interface ComputeOffer {
  offerId: number;
  gpuName: string;
  gpuRamGb: number;
  hourlyRateMicroUsd: number;
  expectedWaitMinutes: number;
  simulated: boolean;
}

export interface ComputeProvider {
  findOffer(requirements: { modelId: string; filters?: GpuFilters | undefined }): Promise<ComputeOffer | null>;
  createInstance(offer: ComputeOffer, context: { label: string; modelId: string }): Promise<{ instanceId: number }>;
  waitUntilReady(instanceId: number, timeoutMs: number): Promise<void>;
  destroyInstance(instanceId: number): Promise<void>;
}

export interface InferenceRuntime {
  stream(input: {
    sessionId: string;
    modelId: string;
    instanceId: number | null;
    prompt: string;
    signal: AbortSignal;
    onDelta: (kind: StreamKind, text: string) => void;
  }): Promise<{ tokens: number; text: string }>;
}

export type SessionErrorCode =
  | "ESTIMATE_REQUIRED"
  | "SESSION_CONFLICT"
  | "MODEL_NOT_READY"
  | "PROVIDER_UNAVAILABLE"
  | "NOT_FOUND";

export class SessionError extends Error {
  constructor(
    public readonly code: SessionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SessionError";
  }
}

export interface SessionOrchestratorOptions {
  store: SessionStore;
  compute: ComputeProvider;
  inference: InferenceRuntime;
  idleTimeoutMinutes: number;
  installId?: string;
  now?: () => number;
  logger?: { info(message: string, context?: Record<string, unknown>): void; warn(message: string, context?: Record<string, unknown>): void } | undefined;
  readinessTimeoutMs?: number;
  /** Returns the user's current GPU preferences so offers respect them. */
  filters?: () => GpuFilters | undefined;
}

interface SessionRuntime {
  session: Session;
  lastActivityAt: number;
  abort: AbortController | null;
}

const DEFAULT_READINESS_TIMEOUT_MS = 5 * 60_000;

/**
 * Owns the chargeable lifecycle of every session. Any number of sessions may run
 * at once (one per model conversation), nothing is provisioned without a
 * confirmed estimate (FR-007), and each session is released on idle, on demand,
 * or by crash reconciliation (FR-012/FR-013).
 */
export class SessionOrchestrator {
  private readonly now: () => number;
  private readonly estimates = new Map<string, Estimate>();
  private readonly runtimes = new Map<string, SessionRuntime>();

  constructor(private readonly options: SessionOrchestratorOptions) {
    this.now = options.now ?? (() => Date.now());

    for (const session of options.store.getActive()) {
      this.runtimes.set(session.id, { session, lastActivityAt: this.now(), abort: null });
    }
  }

  async createEstimate(modelId: string, expectedMinutes = 30): Promise<Estimate> {
    const filters = this.options.filters?.();
    const offer = await this.options.compute.findOffer({ modelId, filters });
    if (!offer) {
      throw new SessionError(
        "PROVIDER_UNAVAILABLE",
        filters && hasActiveFilters(filters)
          ? "No GPU matches this model and your GPU filters. Relax the filters in Settings and try again."
          : "No GPU offer currently meets this model's requirements."
      );
    }

    const estimate = buildEstimate({
      id: randomUUID(),
      modelId,
      offer,
      expectedMinutes,
      now: new Date(this.now()),
      simulated: offer.simulated
    });

    this.estimates.set(estimate.id, estimate);
    return estimate;
  }

  async start(input: SessionStart): Promise<Session> {
    if (input.confirmEstimate !== true) {
      throw new SessionError(
        "ESTIMATE_REQUIRED",
        "Confirm the cost estimate before starting a session."
      );
    }

    const estimate = this.estimates.get(input.estimateId);
    if (!estimate) {
      throw new SessionError(
        "ESTIMATE_REQUIRED",
        "This estimate is no longer valid. Request a new estimate and review it."
      );
    }

    const filters = this.options.filters?.();
    const offer = await this.options.compute.findOffer({ modelId: estimate.modelId, filters });
    if (!offer) {
      throw new SessionError("PROVIDER_UNAVAILABLE", "The selected GPU is no longer available.");
    }

    const sessionId = randomUUID();
    const label = offer.simulated
      ? `maia:mock:${sessionId}`
      : `${this.options.installId ?? "maia"}:${sessionId}`;
    const startedAt = new Date(this.now()).toISOString();

    let instanceId: number | null = null;
    let inserted = false;
    const pendingLogs: Array<{ level: "info" | "warn" | "error"; message: string; at: Date }> = [];

    const log = (level: "info" | "warn" | "error", message: string): void => {
      const at = new Date(this.now());

      if (inserted) {
        this.options.store.appendEvent(sessionId, level, message, at);
        return;
      }

      // `session_events` has a foreign key to the session row, so early events
      // are buffered and written right after the insert.
      pendingLogs.push({ level, message, at });
    };

    try {
      log("info", `Estimate confirmed: ${offer.gpuName} (${offer.gpuRamGb} GB) at $${(offer.hourlyRateMicroUsd / 1_000_000).toFixed(2)}/h`);
      log("info", "Creating the GPU instance…");

      const created = await this.options.compute.createInstance(offer, {
        label,
        modelId: estimate.modelId
      });
      instanceId = created.instanceId;
      log("info", `Instance ${instanceId} requested. Waiting for vast.ai to assign it…`);

      this.options.store.insert({
        id: sessionId,
        modelId: estimate.modelId,
        state: "provisioning",
        runtime: "vllm",
        label,
        gpuName: offer.gpuName,
        gpuRamGb: offer.gpuRamGb,
        hourlyRateMicroUsd: offer.hourlyRateMicroUsd,
        estimatedTotalMicroUsd: estimate.projectedTotalMicroUsd,
        startedAt,
        containerImage: "vllm/vllm-openai:latest"
      });
      this.options.store.setInstance(sessionId, instanceId, offer.offerId);
      inserted = true;
      for (const entry of pendingLogs) {
        this.options.store.appendEvent(sessionId, entry.level, entry.message, entry.at);
      }
      pendingLogs.length = 0;

      // Expose the session immediately so the UI can show "Provisioning" and the
      // lifecycle log while the instance boots.
      const provisioning = this.options.store.get(sessionId);
      if (provisioning) {
        this.runtimes.set(sessionId, {
          session: provisioning,
          lastActivityAt: this.now(),
          abort: null
        });
      }

      log("info", "Booting the instance and downloading the model…");
      await this.options.compute.waitUntilReady(
        instanceId,
        this.options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
      );
      log("info", "Model server is healthy; warming up.");

      this.options.store.transition(sessionId, "ready", {
        readyAt: new Date(this.now()).toISOString()
      });
      const session = this.options.store.get(sessionId);
      if (!session) {
        throw new SessionError("NOT_FOUND", "The session disappeared while provisioning.");
      }

      this.options.store.transition(sessionId, "active");
      const activeSession: Session = { ...session, state: "active" };
      log("info", "Session active. You can chat now.");
      this.runtimes.set(sessionId, {
        session: { ...activeSession, events: this.options.store.eventsFor(sessionId) },
        lastActivityAt: this.now(),
        abort: null
      });
      this.estimates.delete(estimate.id);

      this.options.logger?.info("Session active", {
        sessionId,
        modelId: estimate.modelId,
        instanceId,
        running: this.runtimes.size
      });

      return activeSession;
    } catch (error) {
      this.options.store.transition(sessionId, "failed", {
        endedAt: new Date(this.now()).toISOString(),
        endReason: "failure",
        failureCode: error instanceof SessionError ? error.code : "INTERNAL"
      });

      if (inserted) {
        this.options.store.appendEvent(
          sessionId,
          "error",
          error instanceof Error ? error.message : String(error),
          new Date(this.now())
        );
      } else {
        this.options.logger?.warn("Session provisioning failed before the row existed", {
          sessionId,
          message: error instanceof Error ? error.message : String(error)
        });
      }

      if (instanceId !== null) {
        await this.options.compute.destroyInstance(instanceId).catch(() => undefined);
      }

      throw error;
    }
  }

  listSessions(): Session[] {
    return [...this.runtimes.values()].map((runtime) => this.refresh(runtime).session);
  }

  getSession(sessionId: string): Session | null {
    const runtime = this.runtimes.get(sessionId);
    return runtime ? this.refresh(runtime).session : null;
  }

  /** First running session for a model, used when reviving a conversation. */
  findSessionForModel(modelId: string): Session | null {
    for (const runtime of this.runtimes.values()) {
      if (runtime.session.modelId === modelId) {
        return this.refresh(runtime).session;
      }
    }

    return null;
  }

  getStatus(): Session | null {
    const [first] = this.runtimes.values();
    return first ? this.refresh(first).session : null;
  }

  async send(
    sessionId: string,
    content: string,
    onDelta: (kind: StreamKind, text: string) => void
  ): Promise<{ tokens: number; text: string }> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      throw new SessionError("NOT_FOUND", "That model is not running any more.");
    }

    if (runtime.session.state !== "active") {
      throw new SessionError(
        "MODEL_NOT_READY",
        runtime.session.state === "provisioning"
          ? "The model is still starting. Wait for the session to become active."
          : "That model is not accepting messages in its current state."
      );
    }

    this.touchActivity(sessionId);
    const abort = new AbortController();
    runtime.abort = abort;

    try {
      return await this.options.inference.stream({
        sessionId,
        modelId: runtime.session.modelId,
        instanceId: runtime.session.instanceId,
        prompt: content,
        signal: abort.signal,
        onDelta
      });
    } finally {
      runtime.abort = null;
      this.touchActivity(sessionId);
    }
  }

  abort(sessionId: string): void {
    this.runtimes.get(sessionId)?.abort?.abort();
  }

  touchActivity(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      runtime.lastActivityAt = this.now();
    }
  }

  /** Releases GPUs whose sessions have been idle past the configured window. */
  async reapIdle(): Promise<Session[]> {
    const idleMs = this.options.idleTimeoutMinutes * 60_000;
    const expired = [...this.runtimes.entries()].filter(
      ([, runtime]) =>
        runtime.session.state === "active" && this.now() - runtime.lastActivityAt >= idleMs
    );

    const released: Session[] = [];
    for (const [sessionId] of expired) {
      const ended = await this.end(sessionId, "idle");
      if (ended) {
        released.push(ended);
      }
    }

    return released;
  }

  async end(sessionId: string, reason: NonNullable<Session["endReason"]>): Promise<Session | null> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return null;
    }

    this.options.store.transition(sessionId, "ending");
    runtime.abort?.abort();
    this.options.store.appendEvent(
      sessionId,
      "info",
      reason === "idle" ? "Releasing the GPU after the idle timeout" : "Releasing the GPU",
      new Date(this.now())
    );

    if (runtime.session.instanceId !== null) {
      await this.options.compute.destroyInstance(runtime.session.instanceId).catch((error: unknown) => {
        this.options.logger?.warn("Instance teardown failed; it will be reconciled on next start", {
          sessionId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }

    this.options.store.transition(sessionId, reason === "failure" ? "failed" : "ended", {
      endedAt: new Date(this.now()).toISOString(),
      endReason: reason
    });

    const ended = this.options.store.get(sessionId);
    this.runtimes.delete(sessionId);
    return ended;  }

  /** Releases every running GPU, used when the app exits (FR-012, FR-073). */
  async endAll(reason: NonNullable<Session["endReason"]>): Promise<void> {
    const ids = [...this.runtimes.keys()];

    await Promise.all(
      ids.map(async (sessionId) => {
        await this.end(sessionId, reason).catch((error: unknown) => {
          this.options.logger?.warn("Failed to release a session during shutdown", {
            sessionId,
            message: error instanceof Error ? error.message : String(error)
          });
        });
      })
    );
  }

  /**
   * Destroys instances left behind by a crash or a failed teardown (FR-013).
   * Returns the number of sessions that were reconciled.
   */
  async reconcile(): Promise<number> {
    const orphans = this.options.store.getActive();
    let reconciled = 0;

    for (const orphan of orphans) {
      if (orphan.instanceId !== null) {
        await this.options.compute.destroyInstance(orphan.instanceId).catch(() => undefined);
      }

      this.options.store.transition(orphan.id, "ended", {
        endedAt: new Date(this.now()).toISOString(),
        endReason: "reconciled"
      });
      this.runtimes.delete(orphan.id);
      reconciled += 1;
    }

    if (reconciled > 0) {
      this.options.logger?.warn("Reconciled orphaned sessions", { reconciled });
    }

    return reconciled;
  }

  private refresh(runtime: SessionRuntime): SessionRuntime {
    const fresh = this.options.store.get(runtime.session.id);
    if (fresh) {
      runtime.session = fresh;
    }

    return runtime;
  }
}

export function hasActiveFilters(filters: GpuFilters): boolean {
  return (
    filters.countries.length > 0 ||
    filters.datacenters.length > 0 ||
    filters.minReliability !== null ||
    filters.maxHourlyMicroUsd !== null
  );
}
