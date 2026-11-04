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
  findOffer(requirements: {
    modelId: string;
    filters?: GpuFilters | undefined;
    /** Offers that already failed to book, so a retry picks a different machine. */
    excludeOfferIds?: number[] | undefined;
  }): Promise<ComputeOffer | null>;
  createInstance(offer: ComputeOffer, context: { label: string; modelId: string }): Promise<{ instanceId: number }>;
  waitUntilReady(
    instanceId: number,
    timeoutMs: number,
    onProgress?: (update: ProvisioningProgress) => void
  ): Promise<void>;
  destroyInstance(instanceId: number): Promise<void>;
  /** Instances carrying one of our labels, used to reclaim machines after a crash. */
  listLabelledInstances?(prefix: string): Promise<Array<{ instanceId: number; label: string }>>;
  /**
   * True when the failure means "that machine is gone" rather than "this request is
   * wrong", so the session can be retried on another offer instead of failing.
   */
  isOfferUnavailable?(error: unknown): boolean;
}

/** A status change reported by the provider while the instance boots. */
export interface ProvisioningProgress {
  status: string;
  message: string | null;
  elapsedMs: number;
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
  /** Injectable pause between booking attempts so tests stay fast. */
  delay?: (ms: number) => Promise<void>;
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

/**
 * A cold start moves ~25 GB and then loads the weights: minutes, not seconds. The
 * startup gates keep the typical case at 2–5 minutes; this is the safety net.
 */
const DEFAULT_READINESS_TIMEOUT_MS = 20 * 60_000;

/** Every instance the app rents carries this label, so orphans can be found. */
const SESSION_LABEL_PREFIX = "maia:";

/**
 * Offers churn constantly on vast.ai: roughly three quarters of the listed asks
 * disappear within seconds, so a booking may need several tries.
 */
const MAX_OFFER_ATTEMPTS = 6;

/** States in which a session can serve chat (now or once it finishes booting). */
function isServing(state: Session["state"]): boolean {
  return state === "provisioning" || state === "ready" || state === "active";
}

/**
 * Owns the chargeable lifecycle of every session. Any number of sessions may run
 * at once (one per model conversation), nothing is provisioned without a
 * confirmed estimate (FR-007), and each session is released on idle, on demand,
 * or by crash reconciliation (FR-012/FR-013).
 */
export class SessionOrchestrator {
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly estimates = new Map<string, Estimate>();
  private readonly runtimes = new Map<string, SessionRuntime>();
  /** In-flight boot sequences, so a session can be awaited or released safely. */
  private readonly provisioning = new Map<string, Promise<void>>();

  constructor(private readonly options: SessionOrchestratorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.delay =
      options.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    for (const session of options.store.getActive()) {
      this.runtimes.set(session.id, { session, lastActivityAt: this.now(), abort: null });
    }
  }

  async createEstimate(modelId: string, expectedMinutes = 30): Promise<Estimate> {
    const filters = this.options.filters?.();
    const offer = await this.options.compute.findOffer({ modelId, filters });
    if (!offer) {
      throw new SessionError("PROVIDER_UNAVAILABLE", noOfferMessage(filters));
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
    let offer = await this.options.compute.findOffer({ modelId: estimate.modelId, filters });
    if (!offer) {
      throw new SessionError("PROVIDER_UNAVAILABLE", noOfferMessage(filters));
    }

    const sessionId = randomUUID();
    // The session id is the last label segment, which lets startup reclaim
    // machines even when the database row is already marked failed.
    const label = offer.simulated
      ? `maia:mock:${sessionId}`
      : `${SESSION_LABEL_PREFIX}${sessionId}`;
    const startedAt = new Date(this.now()).toISOString();

    // Replace a previous failed attempt for the same model so the list does not
    // accumulate dead sessions.
    for (const [id, runtime] of this.runtimes) {
      if (runtime.session.modelId === estimate.modelId && runtime.session.state === "failed") {
        this.runtimes.delete(id);
      }
    }

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

      const triedOfferIds: number[] = [];
      let created: { instanceId: number } | null = null;
      let lastError: unknown = null;

      // Renting must feel seamless: any booking failure (a machine taken by
      // someone else, a price change, a transient 5xx) is retried on the next
      // best offer. Almost a quarter of the listed asks churn within seconds.
      for (let attempt = 1; created === null; attempt += 1) {
        try {
          created = await this.options.compute.createInstance(offer, {
            label,
            modelId: estimate.modelId
          });
        } catch (error) {
          lastError = error;
          const canRetry = attempt < MAX_OFFER_ATTEMPTS;

          if (!canRetry) {
            break;
          }

          triedOfferIds.push(offer.offerId);
          const detail = error instanceof Error ? error.message : String(error);
          this.options.logger?.warn("GPU booking failed; trying another offer", {
            offerId: offer.offerId,
            attempt,
            of: MAX_OFFER_ATTEMPTS,
            detail
          });
          log("warn", `${offer.gpuName} could not be booked (attempt ${attempt} of ${MAX_OFFER_ATTEMPTS}). Trying another GPU…`);
          await this.delay(attempt * 150);

          const next = await this.options.compute.findOffer({
            modelId: estimate.modelId,
            filters,
            excludeOfferIds: triedOfferIds
          });
          if (!next) {
            break;
          }

          offer = next;
          log(
            "info",
            `Trying ${offer.gpuName} (${offer.gpuRamGb} GB) at $${(offer.hourlyRateMicroUsd / 1_000_000).toFixed(2)}/h instead.`
          );
        }
      }

      if (created === null) {
        const offerChurned = this.options.compute.isOfferUnavailable?.(lastError) === true;

        if (offerChurned) {
          throw new SessionError(
            "PROVIDER_UNAVAILABLE",
            `Every GPU we tried was taken before it could be booked (${triedOfferIds.length} attempted). The marketplace is busy right now — press start again.`
          );
        }

        throw lastError ?? new SessionError("PROVIDER_UNAVAILABLE", "Could not book a GPU.");
      }

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
      // The estimate is spent as soon as the GPU is booked, so a double click
      // cannot rent a second machine for the same confirmation.
      this.estimates.delete(estimate.id);
      for (const entry of pendingLogs) {
        this.options.store.appendEvent(sessionId, entry.level, entry.message, entry.at);
      }
      pendingLogs.length = 0;

      // Expose the session immediately so the UI can show "Provisioning" and the
      // lifecycle log while the instance boots.
      const provisioning = this.options.store.get(sessionId);
      if (!provisioning) {
        throw new SessionError("NOT_FOUND", "The session could not be stored; the GPU is released again.");
      }

      this.runtimes.set(sessionId, {
        session: provisioning,
        lastActivityAt: this.now(),
        abort: null
      });

      // Booting a model takes minutes. The caller must not be blocked for that
      // long, otherwise a second model cannot be started while the first one is
      // still downloading: the whole point of running models in parallel.
      this.trackProvisioning(sessionId, this.activateSession(sessionId, estimate, instanceId));

      return provisioning;
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
        await this.options.compute.destroyInstance(instanceId).catch((teardownError: unknown) => {
          // A GPU that cannot be released keeps billing, so never swallow this.
          this.options.logger?.warn("Failed to release the GPU after a booking error", {
            sessionId,
            instanceId,
            message: teardownError instanceof Error ? teardownError.message : String(teardownError)
          });
        });
      }

      throw error;
    }
  }

  /**
   * Boots a booked instance to the point where it can answer: waits for the GPU,
   * then for vLLM to serve the model. Runs in the background so several models
   * can provision at the same time.
   */
  private async activateSession(sessionId: string, estimate: Estimate, instanceId: number): Promise<void> {
    const append = (level: "info" | "warn" | "error", message: string): void => {
      this.options.store.appendEvent(sessionId, level, message, new Date(this.now()));
    };
    const stillProvisioning = (): boolean =>
      this.runtimes.get(sessionId)?.session.state === "provisioning";

    try {
      const bootStartedAt = Date.now();
      append("info", "Booting the instance and downloading the model…");
      await this.options.compute.waitUntilReady(
        instanceId,
        this.options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
        (update) => {
          // Each provider status change is one line, so a slow boot shows
          // progress instead of silence.
          const detail = update.message ? ` — ${update.message}` : "";
          append("info", `${describeStatus(update.status)}${detail} (${formatDuration(update.elapsedMs)})`);
        }
      );

      // The session may have been released while the model was loading; in that
      // case there is nothing to activate and the instance is already destroyed.
      if (!stillProvisioning()) {
        return;
      }

      append("info", `Model server is healthy after ${formatDuration(Date.now() - bootStartedAt)}.`);
      this.options.store.transition(sessionId, "ready", {
        readyAt: new Date(this.now()).toISOString()
      });
      this.options.store.transition(sessionId, "active");
      append("info", "Session active. You can chat now.");

      const active = this.options.store.get(sessionId);
      const runtime = this.runtimes.get(sessionId);
      if (active && runtime) {
        runtime.session = { ...active, events: this.options.store.eventsFor(sessionId) };
        runtime.lastActivityAt = this.now();
      }

      this.options.logger?.info("Session active", {
        sessionId,
        modelId: estimate.modelId,
        instanceId,
        running: this.runtimes.size
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn("Session provisioning failed", {
        sessionId,
        modelId: estimate.modelId,
        instanceId,
        message
      });

      if (stillProvisioning()) {
        this.options.store.appendEvent(sessionId, "error", message, new Date(this.now()));
        this.options.store.transition(sessionId, "failed", {
          endedAt: new Date(this.now()).toISOString(),
          endReason: "failure",
          failureCode: "PROVIDER_UNAVAILABLE"
        });

        // Keep the failed session visible: its log is the only explanation for
        // why the GPU never came up. The next start for this model replaces it.
        const failed = this.options.store.get(sessionId);
        const runtime = this.runtimes.get(sessionId);
        if (failed && runtime) {
          runtime.session = failed;
        }
      }

      await this.options.compute.destroyInstance(instanceId).catch((teardownError: unknown) => {
        // A GPU that cannot be released keeps billing, so never swallow this.
        this.options.logger?.warn("Failed to release the GPU after a provisioning error", {
          sessionId,
          instanceId,
          message: teardownError instanceof Error ? teardownError.message : String(teardownError)
        });
      });
    }
  }

  private trackProvisioning(sessionId: string, task: Promise<void>): void {
    const settled = task.catch(() => undefined).finally(() => {
      this.provisioning.delete(sessionId);
    });
    this.provisioning.set(sessionId, settled);
  }

  /** Resolves when a session stops booting; used by tests and by shutdown paths. */
  async awaitProvisioning(sessionId: string): Promise<void> {
    await this.provisioning.get(sessionId);
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
      if (runtime.session.modelId === modelId && isServing(runtime.session.state)) {
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

    // A crash can leave instances whose session row already says "failed", which
    // the query above skips. Anything labelled by this app and not backed by a
    // live session is released here, so no GPU keeps billing unattended.
    const labelled = await this.options.compute.listLabelledInstances?.(SESSION_LABEL_PREFIX).catch(
      () => []
    );

    if (labelled && labelled.length > 0) {
      const live = new Set(this.options.store.getActive().map((session) => session.id));

      for (const { instanceId, label } of labelled) {
        const sessionId = label.split(":").pop() ?? "";
        if (live.has(sessionId)) {
          continue;
        }

        await this.options.compute.destroyInstance(instanceId).catch((error: unknown) => {
          this.options.logger?.warn("Could not release an untracked instance", {
            instanceId,
            message: error instanceof Error ? error.message : String(error)
          });
        });
        this.options.logger?.warn("Released an untracked instance", { instanceId, label });
        reconciled += 1;
      }
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

/** "Waiting for the host to allocate the instance" and friends. */
function describeStatus(status: string): string {
  switch (status) {
    case "created":
      return "Instance created";
    case "scheduling":
      return "Waiting for the host to allocate the instance";
    case "loading":
      return "Pulling the container image and starting it";
    case "running":
      return "Container is running";
    case "starting":
      return "Waiting for the model server to answer";
    case "serving":
      return "Model server is serving at";
    default:
      return `Instance status: ${status}`;
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds} s`;
  }

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} m ${String(rest).padStart(2, "0")} s`;
}

/** "≥1000 Mbps down, ≥200 Mbps up, ≥500 MB/s disk" — what the gates allow. */
export function describeStartupGates(filters: GpuFilters): string {
  const parts: string[] = [];

  if (filters.minDownloadMbps) {
    parts.push(`≥${filters.minDownloadMbps} Mbps down`);
  }
  if (filters.minUploadMbps) {
    parts.push(`≥${filters.minUploadMbps} Mbps up`);
  }
  if (filters.minDiskBandwidthMBps) {
    parts.push(`≥${filters.minDiskBandwidthMBps} MB/s disk`);
  }

  return parts.join(", ");
}

/**
 * A model needs a GPU that is rentable, recent enough for vLLM and fast enough to
 * boot in minutes; when nothing qualifies, say which gate is in the way.
 */
function noOfferMessage(filters: GpuFilters | undefined): string {
  const gates = filters ? describeStartupGates(filters) : "";

  if (gates.length > 0) {
    return `No GPU is both available and fast enough right now (startup gates: ${gates}). Try again in a moment, or lower the gates in Settings → GPU preferences.`;
  }

  if (filters && hasActiveFilters(filters)) {
    return "No GPU matches this model and your GPU filters. Relax the filters in Settings and try again.";
  }

  return "No GPU offer currently meets this model's requirements.";
}
