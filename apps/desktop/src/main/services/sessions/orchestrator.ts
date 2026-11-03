import { randomUUID } from "node:crypto";
import type { Estimate, Session, SessionStart } from "@maia/contracts";
import { buildEstimate } from "../cost/estimator";
import type { SessionStore } from "./store";

export interface ComputeOffer {
  offerId: number;
  gpuName: string;
  gpuRamGb: number;
  hourlyRateMicroUsd: number;
  expectedWaitMinutes: number;
  simulated: boolean;
}

export interface ComputeProvider {
  findOffer(requirements: { modelId: string }): Promise<ComputeOffer | null>;
  createInstance(offer: ComputeOffer, label: string): Promise<{ instanceId: number }>;
  waitUntilReady(instanceId: number, timeoutMs: number): Promise<void>;
  destroyInstance(instanceId: number): Promise<void>;
}

export interface InferenceRuntime {
  stream(input: {
    sessionId: string;
    modelId: string;
    prompt: string;
    signal: AbortSignal;
    onDelta: (text: string) => void;
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
}

const DEFAULT_READINESS_TIMEOUT_MS = 5 * 60_000;

/**
 * Owns the whole chargeable lifecycle: estimate → provisioning → ready → active
 * → ending → ended. Nothing is provisioned without a confirmed estimate
 * (FR-007), and only one session may be active per installation (FR-014).
 */
export class SessionOrchestrator {
  private readonly now: () => number;
  private readonly estimates = new Map<string, Estimate>();
  private active: { session: Session; lastActivityAt: number; abort: AbortController | null } | null = null;

  constructor(private readonly options: SessionOrchestratorOptions) {
    this.now = options.now ?? (() => Date.now());

    // Rebuild in-memory state from the database after a restart.
    const [existing] = options.store.getActive();
    if (existing) {
      this.active = { session: existing, lastActivityAt: this.now(), abort: null };
    }
  }

  async createEstimate(modelId: string, expectedMinutes = 30): Promise<Estimate> {
    const offer = await this.options.compute.findOffer({ modelId });
    if (!offer) {
      throw new SessionError(
        "PROVIDER_UNAVAILABLE",
        "No GPU offer currently meets this model's requirements."
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

    if (this.active) {
      throw new SessionError(
        "SESSION_CONFLICT",
        "A session is already running. End it before starting another one."
      );
    }

    const offer = await this.options.compute.findOffer({ modelId: estimate.modelId });
    if (!offer) {
      throw new SessionError("PROVIDER_UNAVAILABLE", "The selected GPU is no longer available.");
    }

    const sessionId = randomUUID();
    const label = `${this.options.installId ?? "maia"}:${sessionId}`;
    const startedAt = new Date(this.now()).toISOString();

    let instanceId: number | null = null;

    try {
      const created = await this.options.compute.createInstance(offer, label);
      instanceId = created.instanceId;

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

      await this.options.compute.waitUntilReady(
        instanceId,
        this.options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
      );

      this.options.store.transition(sessionId, "ready", { readyAt: new Date(this.now()).toISOString() });
      const session = this.options.store.get(sessionId);
      if (!session) {
        throw new SessionError("NOT_FOUND", "The session disappeared while provisioning.");
      }

      this.options.store.transition(sessionId, "active");
      const activeSession: Session = { ...session, state: "active" };
      this.active = { session: activeSession, lastActivityAt: this.now(), abort: null };
      this.estimates.delete(estimate.id);

      this.options.logger?.info("Session active", {
        sessionId,
        modelId: estimate.modelId,
        instanceId
      });

      return activeSession;
    } catch (error) {
      this.options.store.transition(sessionId, "failed", {
        endedAt: new Date(this.now()).toISOString(),
        endReason: "failure",
        failureCode: error instanceof SessionError ? error.code : "INTERNAL"
      });

      if (instanceId !== null) {
        await this.options.compute.destroyInstance(instanceId).catch(() => undefined);
      }

      throw error;
    }
  }

  getStatus(): Session | null {
    if (this.active) {
      const fresh = this.options.store.get(this.active.session.id);
      if (fresh) {
        this.active.session = fresh;
      }
    }

    return this.active?.session ?? null;
  }

  async send(
    sessionId: string,
    content: string,
    onDelta: (text: string) => void
  ): Promise<{ tokens: number; text: string }> {
    const active = this.active;
    if (!active || active.session.id !== sessionId) {
      throw new SessionError("NOT_FOUND", "No active session to send a message to.");
    }

    this.touchActivity();
    const abort = new AbortController();
    active.abort = abort;

    try {
      return await this.options.inference.stream({
        sessionId,
        modelId: active.session.modelId,
        prompt: content,
        signal: abort.signal,
        onDelta
      });
    } finally {
      active.abort = null;
      this.touchActivity();
    }
  }

  abort(sessionId: string): void {
    if (this.active?.session.id === sessionId) {
      this.active.abort?.abort();
    }
  }

  touchActivity(): void {
    if (this.active) {
      this.active.lastActivityAt = this.now();
    }
  }

  /** Releases the GPU after the configured idle window (FR-012). */
  async reapIdle(): Promise<Session | null> {
    const active = this.active;
    if (!active) {
      return null;
    }

    const idleMs = this.options.idleTimeoutMinutes * 60_000;
    if (this.now() - active.lastActivityAt < idleMs) {
      return null;
    }

    return this.end(active.session.id, "idle");
  }

  async end(sessionId: string, reason: NonNullable<Session["endReason"]>): Promise<Session | null> {
    const active = this.active;
    if (!active || active.session.id !== sessionId) {
      return null;
    }

    this.options.store.transition(sessionId, "ending");
    active.abort?.abort();

    if (active.session.instanceId !== null) {
      await this.options.compute.destroyInstance(active.session.instanceId).catch((error: unknown) => {
        this.options.logger?.warn("Instance teardown failed; it will be reconciled on next start", {
          sessionId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }

    const endedAt = new Date(this.now()).toISOString();
    this.options.store.transition(sessionId, reason === "failure" ? "failed" : "ended", {
      endedAt,
      endReason: reason
    });

    const ended = this.options.store.get(sessionId);
    this.active = null;
    return ended;
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
      reconciled += 1;
    }

    if (reconciled > 0) {
      this.active = null;
      this.options.logger?.warn("Reconciled orphaned sessions", { reconciled });
    }

    return reconciled;
  }
}
