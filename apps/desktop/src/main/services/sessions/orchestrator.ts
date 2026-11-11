import { randomUUID } from "node:crypto";
import {
  DEFAULT_GPU_STARTUP_RETRIES,
  type Estimate,
  type EstimatePreview,
  type FailureEvent,
  type GpuFilters,
  type PowerTier,
  type Session,
  type SessionStart
} from "@maia/contracts";
import { buildEstimate } from "../cost/estimator";
import { describeMemoryFailure, describeModelFailure, extractRootCause } from "./failure";
import { DEFAULT_POWER_TIER, projectTokensPerSecond, tierFilters } from "./power";
import type { SessionStore } from "./store";

export type StreamKind = "content" | "reasoning";

export interface ComputeOffer {
  offerId: number;
  /** Stable host identity (vast.ai machine_id); null for simulated offers. */
  machineId: number | null;
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
    /** Machines that cannot start a container, so a retry never returns to them. */
    excludeMachineIds?: number[] | undefined;
  }): Promise<ComputeOffer | null>;
  createInstance(
    offer: ComputeOffer,
    context: { label: string; modelId: string; contextScale?: number }
  ): Promise<{ instanceId: number }>;
  waitUntilReady(
    instanceId: number,
    timeoutMs: number,
    onProgress?: (update: ProvisioningProgress) => void
  ): Promise<void>;
  destroyInstance(instanceId: number): Promise<void>;
  /** Instances carrying one of our labels, used to reclaim machines after a crash. */
  listLabelledInstances?(prefix: string): Promise<Array<{ instanceId: number; label: string }>>;
  /**
   * The container's own log, used to explain a failed boot. Optional: providers
   * without log access simply report the status message.
   */
  getInstanceLogs?(instanceId: number): Promise<string | null>;
  /**
   * True when the failure means "that machine is gone" rather than "this request is
   * wrong", so the session can be retried on another offer instead of failing.
   */
  isOfferUnavailable?(error: unknown): boolean;
  /**
   * True when the failure is terminal *for that machine* (the container cannot
   * start), so the machine is published as unstable.
   */
  isUnrecoverable?(error: unknown): boolean;
  /**
   * True when another host could plausibly boot where this one failed (a stuck
   * container, a host that never reported in, a port that never opened). Wider
   * than `isUnrecoverable`: a timeout does not disqualify the machine for other
   * users, but it does make retrying elsewhere worth the user's time.
   * Defaults to `isUnrecoverable` when a provider does not implement it.
   */
  isRetryableStartup?(error: unknown): boolean;
  /** Publishes the outcome so every workspace learns from this attempt. */
  reportOutcome?(input: {
    machineId: number | null;
    gpuName: string;
    outcome: "success" | "failure";
    offerId?: number;
    error?: string;
  }): Promise<void>;
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
  | "GATED_ACCESS_REQUIRED"
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
  /**
   * Extra machines to try when a boot fails on the current one (settings:
   * `gpuStartupRetries`). The total number of GPUs tried is this value + 1.
   */
  startupRetries?: () => number;
  /** Returns the user's current GPU preferences so offers respect them. */
  filters?: () => GpuFilters | undefined;
  /**
   * Refuses a model the runtime cannot serve before anything is rented. The
   * composition root wires this to the catalogue; the orchestrator only needs
   * to know that it may throw (or reject).
   */
  assertRunnable?: (modelId: string) => void | Promise<void>;
  /** Returns true when the catalogue marks a model as gated. */
  isGatedModel?: (modelId: string) => boolean;
  /**
   * Sends a failed start-up to the diagnostics service. Fire-and-forget: the
   * implementation must never throw or block the teardown path.
   */
  reportFailure?: (event: FailureEvent) => void;
  /** Called once when a run reaches a terminal state, after metrics are stored. */
  onRunFinished?: (session: Session) => void;
}

interface SessionRuntime {
  session: Session;
  lastActivityAt: number;
  abort: AbortController | null;
  /** Tokens produced across this run's turns and their generation time. */
  outputTokens: number;
  generationMs: number;
}

/**
 * A cold start moves ~25 GB and then loads the weights: minutes, not seconds. The
 * startup gates keep the typical case at 2–5 minutes; this is the safety net.
 */
/** A cold boot pulls a multi-GB image and then the weights; 20 min was too tight. */
const DEFAULT_READINESS_TIMEOUT_MS = 40 * 60_000;

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
      this.runtimes.set(session.id, {
        session,
        lastActivityAt: this.now(),
        abort: null,
        outputTokens: 0,
        generationMs: 0
      });
    }
  }

  async createEstimate(
    modelId: string,
    expectedMinutes = 30,
    powerTier: PowerTier = DEFAULT_POWER_TIER
  ): Promise<Estimate> {
    // Cheapest place to refuse a model that cannot chat: no offer search, no
    // booking, no boot.
    await this.options.assertRunnable?.(modelId);

    const filters = tierFilters(this.options.filters?.(), powerTier);
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
      simulated: offer.simulated,
      powerTier
    });

    this.estimates.set(estimate.id, estimate);
    return estimate;
  }

  /**
   * Pure read for the catalogue popup: prices the selected tier and projects the
   * output rate. No estimate is created and no provider is booked.
   */
  async previewEstimate(
    modelId: string,
    powerTier: PowerTier,
    expectedMinutes = 30
  ): Promise<EstimatePreview> {
    await this.options.assertRunnable?.(modelId);

    const filters = tierFilters(this.options.filters?.(), powerTier);
    const offer = await this.options.compute.findOffer({ modelId, filters });
    if (!offer) {
      throw new SessionError("PROVIDER_UNAVAILABLE", noOfferMessage(filters));
    }

    const estimate = buildEstimate({
      id: "preview",
      modelId,
      offer,
      expectedMinutes,
      now: new Date(this.now()),
      simulated: offer.simulated,
      powerTier
    });
    const projection = projectTokensPerSecond(this.options.store.recentSpeeds(modelId), powerTier);

    return {
      modelId,
      powerTier,
      hourlyRateMicroUsd: estimate.hourlyRateMicroUsd,
      projectedTotalMicroUsd: estimate.projectedTotalMicroUsd,
      projectedTokensPerSecond: projection.value,
      projectionSource: projection.source,
      sampleCount: projection.sampleCount,
      simulated: offer.simulated
    };
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

    // An embedding or reranking model boots happily and then answers every
    // message with 404, so refuse it before a single minute is billed.
    await this.options.assertRunnable?.(estimate.modelId);

    if (this.options.isGatedModel?.(estimate.modelId) && input.confirmGatedAccess !== true) {
      throw new SessionError(
        "GATED_ACCESS_REQUIRED",
        "Confirm that you have accepted the model terms, have Hugging Face access, and approve running it remotely."
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
        containerImage: "vllm/vllm-openai:latest",
        powerTier: estimate.powerTier
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
        abort: null,
        outputTokens: 0,
        generationMs: 0
      });

      // Booting a model takes minutes. The caller must not be blocked for that
      // long, otherwise a second model cannot be started while the first one is
      // still downloading: the whole point of running models in parallel.
      this.trackProvisioning(
        sessionId,
        this.activateSession(sessionId, estimate, { instanceId, offer }, filters)
      );

      return provisioning;
    } catch (error) {
      this.options.store.transition(sessionId, "failed", {
        endedAt: new Date(this.now()).toISOString(),
        endReason: "failure",
        failureCode: error instanceof SessionError ? error.code : "INTERNAL"
      });
      // The row only exists once a machine was booked, so a booking failure has
      // nothing to attach a measurement to.
      if (this.options.store.get(sessionId)) {
        this.options.store.recordMetric({
          sessionId,
          modelId: estimate.modelId,
          powerTier: estimate.powerTier ?? DEFAULT_POWER_TIER,
          outputTokens: 0,
          generationMs: 0,
          tokensPerSecond: null,
          outcome: "failed",
          recordedAt: new Date(this.now()).toISOString()
        });
      }
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
   * Pulls the container's own output for the diagnostics stream.
   *
   * The interesting lines are almost always the last few (a traceback, a missing
   * file, a CUDA error), so the tail is what travels: a short summary for the
   * session log and the full tail for telemetry.
   */
  private async collectRemoteLogs(
    instanceId: number
  ): Promise<{
    summary: string;
    tail: string;
    /** Deepest error line, searched in the whole log. */
    fullLog: string;
    rootCause: string | null;
    memoryNote: string | null;
  } | null> {
    if (!this.options.compute.getInstanceLogs) {
      return null;
    }

    const raw = await this.options.compute.getInstanceLogs(instanceId).catch(() => null);
    if (!raw) {
      return null;
    }

    const lines = raw
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    const tail = lines.slice(-40).join("\n").slice(-4_000);

    if (tail.length === 0) {
      return null;
    }

    // The real cause is usually *above* the launcher's traceback, often far
    // outside the tail, so it is searched in the whole log.
    return {
      summary: lines.slice(-2).join(" | ").slice(0, 300),
      tail,
      // A gated-repository or missing-config error is logged at download time,
      // long before the traceback that ends the log.
      fullLog: raw.slice(-40_000),
      rootCause: extractRootCause(raw),
      memoryNote: describeMemoryFailure(raw)
    };
  }

  /**
   * Boots a booked instance until vLLM serves the model, moving to another host
   * when this one cannot get the container up or never reports in. The number of
   * switches is capped by the user's `gpuStartupRetries` setting. Runs in the
   * background so several models can provision at the same time.
   */
  private async activateSession(
    sessionId: string,
    estimate: Estimate,
    booking: { instanceId: number; offer: ComputeOffer },
    filters: GpuFilters | undefined
  ): Promise<void> {
    const append = (level: "info" | "warn" | "error", message: string): void => {
      this.options.store.appendEvent(sessionId, level, message, new Date(this.now()));
    };
    const stillProvisioning = (): boolean =>
      this.runtimes.get(sessionId)?.session.state === "provisioning";

    let current = booking;
    const failedMachines: number[] = [];
    const startupRetries = this.options.startupRetries?.() ?? DEFAULT_GPU_STARTUP_RETRIES;
    // Context multiplier for the current attempt. A memory failure halves it so
    // the retry asks for less, instead of repeating the same crash elsewhere.
    let contextScale = 1;

    for (let attempt = 1; ; attempt += 1) {
      const bootStartedAt = Date.now();

      try {
        append("info", `Booting ${current.offer.gpuName} and downloading the model…`);
        await this.options.compute.waitUntilReady(
          current.instanceId,
          this.options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
          (update) => {
            // Each provider status change is one line, so a slow boot shows
            // progress instead of silence.
            const detail = update.message ? ` — ${update.message}` : "";
            const line = `${describeStatus(update.status)}${detail} (${formatDuration(update.elapsedMs)})`;
            append("info", line);

            // Mirror it into the diagnostics stream: the UI log is local to the
            // machine, so a boot that stalls in the field is invisible otherwise.
            this.options.logger?.info("Provisioning progress", {
              sessionId,
              instanceId: current.instanceId,
              modelId: estimate.modelId,
              status: update.status,
              message: update.message,
              elapsedMs: update.elapsedMs
            });
          }
        );

        // The session may have been released while the model was loading; in that
        // case there is nothing to activate and the instance is already destroyed.
        if (!stillProvisioning()) {
          return;
        }

        await this.options.compute.reportOutcome?.({
          machineId: current.offer.machineId,
          gpuName: current.offer.gpuName,
          offerId: current.offer.offerId,
          outcome: "success"
        });

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
          instanceId: current.instanceId,
          attempts: attempt,
          running: this.runtimes.size
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unrecoverable = this.options.compute.isUnrecoverable?.(error) === true;
        const totalAttempts = startupRetries + 1;
        const host = describeHost(current.offer);

        // Ask the container what it actually said before it disappears with the
        // instance: "the port never opened" is not a diagnosis.
        const remoteLogs = await this.collectRemoteLogs(current.instanceId);
        const rootCause = remoteLogs?.rootCause ?? null;
        // "Engine core initialization failed" is a symptom; this says what died.
        const diagnosis = rootCause ? `${message} — ${rootCause}` : message;

        // A model vLLM cannot load fails identically on every machine. The
        // container log is the only place that says so, so it has to be read
        // before the retry decision — otherwise a bad repository rents six GPUs.
        const modelFailure = describeModelFailure({
          message,
          logs: remoteLogs?.fullLog ?? null
        });

        // "The host never reported in" is not a broken request: retrying on
        // another machine usually works, so the retry budget covers it too.
        const retryable =
          modelFailure === null &&
          (this.options.compute.isRetryableStartup?.(error) ?? unrecoverable);

        this.options.logger?.warn("Provisioning attempt failed", {
          sessionId,
          modelId: estimate.modelId,
          instanceId: current.instanceId,
          machineId: current.offer.machineId,
          attempt,
          unrecoverable,
          retryable,
          modelFailure,
          message,
          ...(remoteLogs ? { remoteLogs: remoteLogs.tail } : {})
        });

        // The failure that triggered the switch is the only thing that explains
        // the next line, so it is logged at error level with the host and the
        // attempt it belongs to — never folded into a "trying another GPU" note.
        append(
          "error",
          `${current.offer.gpuName} startup failed on ${host} (attempt ${attempt} of ${totalAttempts}): ${diagnosis}`
        );

        if (remoteLogs) {
          append("error", `Container log: ${remoteLogs.summary}`);
        }

        if (remoteLogs?.memoryNote) {
          contextScale = Math.max(0.25, contextScale / 2);
          append(
            "warn",
            `The container ran out of GPU memory: ${remoteLogs.memoryNote}. The next attempt asks for ${Math.round(
              contextScale * 100
            )}% of the context budget.`
          );
        }

        // Record the attempt while the container log is still in memory: the
        // instance is destroyed below and nothing else will ever see it.
        this.options.reportFailure?.({
          stage: "provisioning",
          modelId: estimate.modelId,
          gpuName: current.offer.gpuName,
          machineId: current.offer.machineId,
          instanceId: current.instanceId,
          attempt,
          attemptsTotal: totalAttempts,
          errorClass: error instanceof Error ? error.name : "Error",
          errorMessage: message.slice(0, 2_000),
          rootCause,
          memoryNote: remoteLogs?.memoryNote ?? null,
          modelFailure,
          contextScale,
          logTail: remoteLogs?.tail ?? null
        });

        if (modelFailure) {
          append(
            "error",
            `This is a model problem, not a GPU problem: ${modelFailure}. Another machine would fail the same way, so no retry is attempted.`
          );
        }

        // The instance is unusable either way; release it before anything else.
        await this.options.compute.destroyInstance(current.instanceId).catch((teardownError: unknown) => {
          this.options.logger?.warn("Failed to release the GPU after a provisioning error", {
            sessionId,
            instanceId: current.instanceId,
            message: teardownError instanceof Error ? teardownError.message : String(teardownError)
          });
        });

        if (unrecoverable) {
          await this.options.compute.reportOutcome?.({
            machineId: current.offer.machineId,
            gpuName: current.offer.gpuName,
            offerId: current.offer.offerId,
            outcome: "failure",
            error: message
          });
        }

        // Retries must never land on the machine that just failed, even when the
        // failure was a timeout rather than a verdict worth sharing.
        if (current.offer.machineId !== null) {
          failedMachines.push(current.offer.machineId);
        }

        const canRetryOnAnotherHost =
          retryable && stillProvisioning() && attempt <= startupRetries;

        if (canRetryOnAnotherHost) {
          append(
            "warn",
            `${current.offer.gpuName} did not come up (${diagnosis}). ${
              unrecoverable ? `Marking ${host} as unstable and ` : ""
            }trying another GPU (retry ${attempt} of ${startupRetries})…`
          );

          const replacement = await this.bookAnotherOffer(
            sessionId,
            estimate.modelId,
            filters,
            failedMachines,
            contextScale
          ).catch(
            (bookingError: unknown) => {
              this.options.logger?.warn("Could not book a replacement GPU", {
                sessionId,
                reason: bookingError instanceof Error ? bookingError.message : String(bookingError)
              });
              append(
                "warn",
                `Could not book a replacement GPU: ${
                  bookingError instanceof Error ? bookingError.message : String(bookingError)
                }`
              );
              return null;
            }
          );

          if (replacement) {
            this.options.store.setInstance(
              sessionId,
              replacement.instanceId,
              replacement.offer.offerId
            );
            append(
              "info",
              `Retrying on ${replacement.offer.gpuName} (${replacement.offer.gpuRamGb} GB) at $${(
                replacement.offer.hourlyRateMicroUsd / 1_000_000
              ).toFixed(2)}/h (attempt ${attempt + 1} of ${totalAttempts}).`
            );
            current = replacement;
            continue;
          }

          // The retry budget was not the limit: there was nothing left to book.
          // Say so, otherwise "3 of 6 attempts" looks like a lost retry.
          append(
            "warn",
            `No other GPU could be booked, so the remaining ${Math.max(
              totalAttempts - attempt,
              0
            )} attempt(s) were skipped (the GPU filters or the price cap may be too tight).`
          );
        }

        if (stillProvisioning()) {
          const reason = modelFailure
            ? `This model cannot be served: ${modelFailure}.`
            : attempt > 1
              ? `Gave up after ${attempt} of ${totalAttempts} GPU attempts. Last error: ${diagnosis}${
                  attempt < totalAttempts
                    ? " No further GPU offers matched your preferences — relax the GPU filters or raise the price cap in Settings."
                    : ` Raise "GPU startup retries" in Settings to try more hosts.`
                }`
              : diagnosis;
          this.options.store.appendEvent(sessionId, "error", reason, new Date(this.now()));
          this.options.reportFailure?.({
            stage: "startup",
            modelId: estimate.modelId,
            gpuName: current.offer.gpuName,
            machineId: current.offer.machineId,
            instanceId: current.instanceId,
            attempt,
            attemptsTotal: totalAttempts,
            errorClass: modelFailure ? "ModelFailure" : "StartupFailure",
            errorMessage: reason.slice(0, 2_000),
            rootCause,
            memoryNote: remoteLogs?.memoryNote ?? null,
            modelFailure,
            contextScale,
            logTail: remoteLogs?.tail ?? null
          });
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

        return;
      }
    }
  }

  /** Books a fresh instance on a machine that has not failed yet. */
  private async bookAnotherOffer(
    sessionId: string,
    modelId: string,
    filters: GpuFilters | undefined,
    excludeMachineIds: number[],
    contextScale: number
  ): Promise<{ instanceId: number; offer: ComputeOffer } | null> {
    const triedOffers: number[] = [];

    for (let attempt = 1; attempt <= MAX_OFFER_ATTEMPTS; attempt += 1) {
      const offer = await this.options.compute.findOffer({
        modelId,
        filters,
        excludeMachineIds,
        excludeOfferIds: triedOffers
      });

      if (!offer) {
        return null;
      }

      try {
        const created = await this.options.compute.createInstance(offer, {
          label: `${SESSION_LABEL_PREFIX}${sessionId}`,
          modelId,
          contextScale
        });
        return { instanceId: created.instanceId, offer };
      } catch (error) {
        triedOffers.push(offer.offerId);
        if (
          this.options.compute.isOfferUnavailable?.(error) !== true ||
          attempt === MAX_OFFER_ATTEMPTS
        ) {
          throw error;
        }
      }
    }

    return null;
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

  /**
   * Ended runs for the Models view. `listSessions()` stays the active-only query
   * that Chat and Catalogue rely on. Reads go straight to the store because the
   * runtimes map only holds in-flight sessions.
   */
  listSessionHistory(): Session[] {
    return this.options.store.getTerminated();
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
    const generationStarted = this.now();

    try {
      const result = await this.options.inference.stream({
        sessionId,
        modelId: runtime.session.modelId,
        instanceId: runtime.session.instanceId,
        prompt: content,
        signal: abort.signal,
        onDelta
      });

      runtime.outputTokens += result.tokens;
      runtime.generationMs += Math.max(0, this.now() - generationStarted);
      return result;
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
    if (ended) {
      this.recordMetrics(runtime, ended, metricOutcome(reason));
      this.options.onRunFinished?.(ended);
    }
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

  /** Persists one run's measurements; the store ignores duplicate writes. */
  private recordMetrics(runtime: SessionRuntime, session: Session, outcome: RunOutcome): void {
    const { outputTokens, generationMs } = runtime;

    this.options.store.recordMetric({
      sessionId: session.id,
      modelId: session.modelId,
      powerTier: session.powerTier ?? DEFAULT_POWER_TIER,
      outputTokens,
      generationMs,
      tokensPerSecond:
        generationMs > 0 && outputTokens > 0
          ? Math.round(((outputTokens / generationMs) * 1000) * 10) / 10
          : null,
      outcome,
      recordedAt: new Date(this.now()).toISOString()
    });
  }

  private refresh(runtime: SessionRuntime): SessionRuntime {    const fresh = this.options.store.get(runtime.session.id);
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
function metricOutcome(reason: NonNullable<Session["endReason"]>): RunOutcome {
  switch (reason) {
    case "idle":
      return "idle";
    case "cap":
      return "capped";
    case "failure":
      return "failed";
    default:
      return "cancelled";
  }
}

type RunOutcome = "completed" | "failed" | "cancelled" | "capped" | "idle";

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

/** "machine 5001" / "a simulated host" — so a log line names who failed. */
function describeHost(offer: ComputeOffer): string {
  return offer.machineId === null ? "a simulated host" : `machine ${offer.machineId}`;
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
