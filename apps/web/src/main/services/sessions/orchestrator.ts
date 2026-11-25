import { randomBytes, randomUUID } from "node:crypto";
import {
  DEFAULT_GPU_STARTUP_RETRIES,
  type Estimate,
  type EstimatePreview,
  type FailureEvent,
  type GpuFilters,
  type ModelCapability,
  type PowerTier,
  type ReleaseReason,
  type RestartResult,
  type RestartState,
  type RuntimeConfig,
  type RuntimeValues,
  type Session,
  type SessionEndpoint,
  type SessionStart
} from "@maia/contracts";
import { buildEstimate } from "../cost/estimator";
import { DEFAULT_VLLM_MAX_SEQS } from "../inference/model-plan";
import { describeMemoryFailure, describeModelFailure, extractRootCause } from "./failure";
import { DEFAULT_POWER_TIER, projectTokensPerSecond, tierFilters } from "./power";
import { validateRestart } from "./restart-policy";
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
    context: {
      label: string;
      modelId: string;
      contextScale?: number;
      apiKey?: string;
      /** Values this boot must apply; absent means the engine defaults. */
      runtime?: { contextWindow?: number; maxConcurrentRequests?: number };
    }
  ): Promise<{ instanceId: number }>;
  waitUntilReady(
    instanceId: number,
    timeoutMs: number,
    onProgress?: (update: ProvisioningProgress) => void
  ): Promise<void>;
  destroyInstance(instanceId: number): Promise<void>;
  /** Instances carrying one of our labels, used to reclaim machines after a crash. */
  listLabelledInstances?(prefix: string): Promise<Array<{ instanceId: number; label: string }>>;
  /** Mapped public host and port of a running instance, when the provider exposes one. */
  resolveEndpoint?(instanceId: number): { host: string; port: number } | null;
  /**
   * The container's own log, used to explain a failed boot. Optional: providers
   * without log access simply report the status message.
   */
  getInstanceLogs?(instanceId: number): Promise<string | null>;
  /**
   * Whether the provider still lists this machine.
   *
   * Used for one question only: may this run be closed? A run that says "ended"
   * while the provider still bills for it is the failure this product must never
   * ship, so the answer is checked before the record is closed.
   */
  instanceExists?(instanceId: number): Promise<boolean>;
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

/** One image on its way to a vision model, already base64 encoded. */
export interface InferenceImage {
  mimeType: string;
  dataBase64: string;
}

/** A stored turn as the model receives it. */
export interface InferenceMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface InferenceRuntime {
  stream(input: {
    sessionId: string;
    modelId: string;
    instanceId: number | null;
    /** The conversation up to and including this turn, oldest first. */
    messages: InferenceMessage[];
    /** Images for vision runs; empty for text-only models. */
    images?: InferenceImage[] | undefined;
    signal: AbortSignal;
    /** The run's key, when the server was started with one. Never logged. */
    apiKey?: string | null;
    onDelta: (kind: StreamKind, text: string) => void;
  }): Promise<{ tokens: number; text: string }>;
}

export type SessionErrorCode =
  | "ESTIMATE_REQUIRED"
  | "GATED_ACCESS_REQUIRED"
  | "SESSION_CONFLICT"
  | "MODEL_NOT_READY"
  | "PROVIDER_UNAVAILABLE"
  | "CAPABILITY_UNSUPPORTED"
  /** The values asked for are outside what the model or the card can use. */
  | "VALIDATION_FAILED"
  /** No provider credential is saved, so nothing can be rented. */
  | "CREDENTIAL_MISSING"
  /** The saved credential was rejected by the provider. */
  | "CREDENTIAL_INVALID"
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
   * What a booting run reports against: a *report point*, never a release
   * trigger. Defaults to the readiness value so one deployment number governs
   * both the adapter and the Run card copy.
   */
  bootCeilingMs?: number;
  /** No progress for this long ends the attempt (adapter default: 15 min). */
  bootQuietWindowMs?: number;
  /** How often the person is reminded while past the ceiling. */
  bootReminderMs?: number;
  /** Fine-grained control for tests; production reads the settings store. */
  capMicroUsd?: () => number;
  /**
   * Header notifications published from the lifecycle: a ready entry, a failed
   * entry, and the withdrawal that follows a run that stops serving.
   */
  notifications?: {
    set(input: {
      key: string;
      severity: "success" | "warning" | "error";
      message: string;
      action?: { label: string; route: string };
      endpoint?: { baseUrl: string; host: string; port: number; modelId: string };
      route?: string;
      dismissible?: boolean;
    }): void;
    clear(key: string): void;
  };
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
  /** What a run of this model can do; defaults to text when unknown. */
  capabilityFor?: (modelId: string) => ModelCapability;
  /** Which engine will serve this model, for the run card's runtime label. */
  runtimeFor?: (modelId: string) => Session["runtime"];
  /** Called once when a run reaches a terminal state, after metrics are stored. */
  onRunFinished?: (session: Session) => void;
  /** The model's documented context window, for the parameter panel. */
  contextWindowFor?: (modelId: string) => number | null;
  /**
   * Advisory card limits for the parameter panel: what this GPU can hold at the
   * requested values. Pure; the composition root owns the catalogue lookups.
   */
  runtimeLimitsFor?: (input: {
    modelId: string;
    gpuRamGb: number;
    contextWindow: number;
    maxConcurrentRequests: number;
  }) => { estimatedMaxContext: number; concurrencyMax: number };
}

interface SessionRuntime {
  session: Session;
  lastActivityAt: number;
  abort: AbortController | null;
  /** The in-flight turn, so a restart can wait for it to settle. */
  sending: Promise<unknown> | null;
  /** Tokens produced across this run's turns and their generation time. */
  outputTokens: number;
  generationMs: number;
  /**
   * Key the model server requires. Generated per run, kept in memory only and
   * never written to a session event, log or usage sample.
   */
  apiKey: string | null;
  /** The offer this run was booked on, so a restart can reuse the same machine. */
  lastOffer: ComputeOffer | null;
}

/**
 * A cold start moves ~25 GB and then loads the weights: minutes, not seconds. The
 * startup gates keep the typical case at 2–5 minutes; this is the safety net.
 */
/** A cold boot pulls a multi-GB image and then the weights; 20 min was too tight. */
const DEFAULT_READINESS_TIMEOUT_MS = 40 * 60_000;

/** When a model documents no window, this is the product's ceiling. */
const PRODUCT_CONTEXT_CEILING = 32_768;
const MIN_CONTEXT = 4_096;

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
 * The reason a failed attempt is recorded under.
 *
 * The adapter already classifies most failures and carries the verdict on the
 * error; this only fills in what a provider-level failure cannot know.
 */
function releaseReasonFrom(error: unknown, modelCaused: boolean): ReleaseReason {
  const explicit = (error as { releaseReason?: ReleaseReason } | null)?.releaseReason;
  if (explicit) {
    return explicit;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/out of memory/i.test(message)) {
    return "out_of_memory";
  }
  if (/compute capability|not supported|no kernel image/i.test(message)) {
    return "gpu_unsupported";
  }
  if (/gated|repository|401|403/i.test(message)) {
    return "repository_missing";
  }

  return modelCaused ? "model_load_failed" : "start_failed";
}

/** Maps a deliberate end to the release vocabulary the history and tally use. */
function releaseReasonForEnd(reason: NonNullable<Session["endReason"]>): ReleaseReason {
  switch (reason) {
    case "cap":
      return "cap_reached";
    case "failure":
      return "start_failed";
    case "reconciled":
      return "instance_gone";
    case "app_exit":
      return "app_exit";
    default:
      return "person_stopped";
  }
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
  /** Runs whose machine could not be confirmed released, retried until it is. */
  private readonly pendingReleases = new Map<string, number>();
  private releaseTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: SessionOrchestratorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.delay =
      options.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    for (const session of options.store.getActive()) {
      this.runtimes.set(session.id, {
        session,
        lastActivityAt: this.now(),
        abort: null,
        sending: null,
        outputTokens: 0,
        generationMs: 0,
        // An inherited session was started by a previous process: its key is
        // gone, so it is reported as terminated on the next reconcile anyway.
        apiKey: null,
        lastOffer: null
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
    // 24 random bytes: long enough that the address alone is worthless, short
    // enough to paste into an editor config.
    const apiKey = `maia_${randomBytes(18).toString("base64url")}`;
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
            modelId: estimate.modelId,
            apiKey
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
        runtime: this.options.runtimeFor?.(estimate.modelId) ?? "vllm",
        label,
        gpuName: offer.gpuName,
        gpuRamGb: offer.gpuRamGb,
        hourlyRateMicroUsd: offer.hourlyRateMicroUsd,
        estimatedTotalMicroUsd: estimate.projectedTotalMicroUsd,
        startedAt,
        containerImage: "vllm/vllm-openai:latest",
        powerTier: estimate.powerTier,
        capability: this.options.capabilityFor?.(estimate.modelId) ?? "text"
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
        sending: null,
        outputTokens: 0,
        generationMs: 0,
        apiKey,
        lastOffer: offer
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
        let lastPhase = "";
        let lastBootWriteAt = 0;
        let lastEndpoint: { host: string; port: number } | null = null;
        await this.options.compute.waitUntilReady(
          current.instanceId,
          this.options.bootCeilingMs ?? this.options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
          (update) => {
            const startedMs = Date.now();
            const isCeiling = update.status === "ceiling";
            const phase = update.message ?? "";

            // The ceiling is a report, not an ending: one line, then a reminder
            // on the orchestrator's own cadence (FR-037).
            if (isCeiling) {
              append("warn", phase);
              return;
            }

            // Persist the phase for the Run card, throttled: the column exists
            // so the person can see progress, not so every status is a write.
            const phaseChanged = phase.length > 0 && phase !== lastPhase;
            if (phase.length > 0 && (phaseChanged || startedMs - lastBootWriteAt >= 10_000)) {
              lastPhase = phase;
              lastBootWriteAt = startedMs;
              const percentMatch = /(\d{1,3})%/.exec(phase);
              const percent = percentMatch ? Math.min(100, Number(percentMatch[1])) : null;
              this.options.store.recordBoot(sessionId, {
                phase: phase.slice(0, 200),
                percent: Number.isFinite(percent ?? NaN) ? percent : null,
                progressAt: new Date(this.now()).toISOString(),
                ceilingAt: new Date(
                  this.now() +
                    (this.options.bootCeilingMs ?? this.options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS)
                ).toISOString()
              });
            }

            // One line per meaningful change, not per poll. A repeated report of
            // the same phase is how the card stays current, not news.
            if (update.status !== "starting" || phaseChanged) {
              const detail = phase ? ` — ${phase}` : "";
              const line = `${describeStatus(update.status)}${detail} (${formatDuration(update.elapsedMs)})`;
              append("info", line);
            }

            // The address exists minutes before the model serves; keeping it lets
            // the run card say "not serving yet" with the real host and port.
            const mapped = this.options.compute.resolveEndpoint?.(current.instanceId);
            if (
              mapped &&
              (lastEndpoint?.host !== mapped.host || lastEndpoint.port !== mapped.port)
            ) {
              lastEndpoint = mapped;
              this.options.store.recordEndpoint(sessionId, mapped.host, mapped.port);
            }

            // Mirror it into the diagnostics stream without the address: a host
            // name or IP never belongs in operational logs (Principle I).
            this.options.logger?.info("Provisioning progress", {
              sessionId,
              instanceId: current.instanceId,
              modelId: estimate.modelId,
              status: update.status,
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
        this.options.store.clearBoot(sessionId);
        append("info", "Session active. You can chat now.");

        // The address, the model and the key are the point of the run, so they
        // are announced once, as a state the header can re-read at any time.
        const mapped = this.options.compute.resolveEndpoint?.(current.instanceId);
        if (mapped) {
          this.options.store.recordEndpoint(sessionId, mapped.host, mapped.port);
          this.options.notifications?.set({
            key: `run:ready:${sessionId}`,
            severity: "success",
            message: `${estimate.modelId} is ready to serve.`,
            endpoint: {
              baseUrl: `http://${mapped.host}:${mapped.port}/v1`,
              host: mapped.host,
              port: mapped.port,
              modelId: estimate.modelId
            },
            route: `/models?run=${sessionId}`,
            dismissible: true
          });
        }

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
        // A person who stopped the run released the machine on purpose; the
        // attempt's failure (and the log of a container that no longer exists)
        // is not news and must not be written down as one.
        if (!stillProvisioning()) {
          return;
        }

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
          const phaseAtFailure = this.options.store.get(sessionId)?.boot?.text ?? null;
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
          this.options.store.recordRelease(sessionId, {
            reason: releaseReasonFrom(error, modelFailure !== null),
            phase: phaseAtFailure,
            elapsedMs: Date.now() - bootStartedAt
          });
          this.options.notifications?.set({
            key: `run:failed:${sessionId}`,
            severity: "error",
            message: `${estimate.modelId} could not start: ${reason.slice(0, 160)}`,
            action: {
              label: "Try again",
              route: `/catalogue?model=${encodeURIComponent(estimate.modelId)}`
            },
            route: `/models?run=${sessionId}`,
            dismissible: true
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

  /** The values a run is using, its engine defaults and the model's ceiling. */
  private effectiveRuntime(session: Session): {
    current: RuntimeValues;
    defaults: RuntimeValues;
    contextWindowMax: number | null;
    contextWindowMaxSource: "model" | "product";
  } {
    if (session.runtimeConfig) {
      const { current, defaults, contextWindowMax, contextWindowMaxSource } = session.runtimeConfig;
      return { current, defaults, contextWindowMax, contextWindowMaxSource };
    }

    // A run from before this feature has no stored values. Report the values the
    // engine actually starts with, never an invented one.
    const documented = this.options.contextWindowFor?.(session.modelId) ?? null;
    const contextWindow = Math.max(
      MIN_CONTEXT,
      Math.min(documented ?? PRODUCT_CONTEXT_CEILING, PRODUCT_CONTEXT_CEILING)
    );
    const values: RuntimeValues = {
      contextWindow,
      maxConcurrentRequests: session.runtime === "llamacpp" ? 1 : DEFAULT_VLLM_MAX_SEQS
    };

    return {
      current: values,
      defaults: values,
      contextWindowMax: documented,
      contextWindowMaxSource: documented === null ? "product" : "model"
    };
  }

  private cardLimits(
    session: Session,
    values: RuntimeValues
  ): { estimatedMaxContext: number; concurrencyMax: number } {
    if (this.options.runtimeLimitsFor && session.gpuRamGb && session.gpuRamGb > 0) {
      return this.options.runtimeLimitsFor({
        modelId: session.modelId,
        gpuRamGb: session.gpuRamGb,
        contextWindow: values.contextWindow,
        maxConcurrentRequests: values.maxConcurrentRequests
      });
    }

    return { estimatedMaxContext: values.contextWindow, concurrencyMax: 8 };
  }

  private accruedMicroUsd(session: Session): number {
    const startedMs = Date.parse(session.startedAt);
    const elapsedHours = Math.max(0, this.now() - startedMs) / 3_600_000;
    return Math.round(elapsedHours * session.hourlyRateMicroUsd);
  }

  /** What the parameter panel shows, or null when there is no live run. */
  runtimeConfig(sessionId: string): RuntimeConfig | null {
    const runtime = this.runtimes.get(sessionId);
    const session = runtime ? this.refresh(runtime).session : this.options.store.get(sessionId);

    if (!session || ["estimated", "ending", "ended", "cancelled", "failed"].includes(session.state)) {
      return null;
    }

    const effective = this.effectiveRuntime(session);
    const limits = this.cardLimits(session, effective.current);

    return {
      current: effective.current,
      defaults: effective.defaults,
      contextWindowMax: effective.contextWindowMax,
      contextWindowMaxSource: effective.contextWindowMaxSource,
      concurrencyMax: limits.concurrencyMax,
      estimatedMaxContext: limits.estimatedMaxContext,
      fits: effective.current.contextWindow <= limits.estimatedMaxContext,
      restart: session.restart
    };
  }

  /**
   * Applies new runtime values by restarting the server on the already-rented
   * machine. The old instance is confirmed gone before a replacement is booked,
   * so no moment in this method bills two machines.
   */
  async restart(sessionId: string, values: RuntimeValues): Promise<RestartResult> {
    const runtime = this.runtimes.get(sessionId);
    const session = runtime ? this.refresh(runtime).session : null;

    if (!runtime || !session) {
      throw new SessionError("NOT_FOUND", "That model is not running any more.");
    }

    const effective = this.effectiveRuntime(session);
    const limits = this.cardLimits(session, values);
    const capMicroUsd = this.options.capMicroUsd?.() ?? 0;
    const check = validateRestart({
      session,
      values,
      current: effective.current,
      contextWindowMax: effective.contextWindowMax,
      concurrencyMax: limits.concurrencyMax,
      capMicroUsd,
      accruedMicroUsd: this.accruedMicroUsd(session)
    });

    if (!check.ok) {
      this.options.store.recordRestart({
        sessionId,
        previous: effective.current,
        target: values,
        outcome: "refused",
        reason: check.refusal.message
      });
      throw new SessionError(check.refusal.code, check.refusal.message);
    }

    const offer = runtime.lastOffer;
    const instanceId = session.instanceId;
    if (!offer || instanceId === null) {
      throw new SessionError(
        "MODEL_NOT_READY",
        "This run cannot be restarted in place. Start the model again, with the values you want."
      );
    }

    // A reply in flight belongs to the old server; stop it and let it settle so
    // the stored turn is marked interrupted before the machine disappears.
    runtime.abort?.abort();
    await runtime.sending?.catch(() => undefined);

    const requestedAt = new Date(this.now()).toISOString();
    const restart: RestartState = {
      startedAt: requestedAt,
      previous: effective.current,
      target: values,
      phase: "stopping"
    };

    this.options.store.transition(sessionId, "provisioning");
    this.options.store.beginRestart(sessionId, restart);
    this.options.store.appendEvent(
      sessionId,
      "info",
      `Restarting with a ${values.contextWindow.toLocaleString()}-token context and ${values.maxConcurrentRequests} concurrent request(s). The GPU stays rented.`,
      new Date(this.now())
    );
    this.options.notifications?.set({
      key: `run:restart:${sessionId}`,
      severity: "warning",
      message: `${session.modelId} is restarting with a ${values.contextWindow.toLocaleString()}-token context.`,
      route: `/models?run=${sessionId}`,
      dismissible: false
    });

    const auditId = this.options.store.recordRestart({
      sessionId,
      previous: effective.current,
      target: values,
      outcome: "started",
      requestedAt
    });

    const fail = (reason: string): RestartResult => {
      this.options.store.transition(sessionId, "failed", {
        endedAt: new Date(this.now()).toISOString(),
        endReason: "failure",
        failureCode: "VALIDATION_FAILED"
      });
      this.options.store.recordRelease(sessionId, {
        reason: "start_failed",
        phase: "restart",
        elapsedMs: Math.max(0, this.now() - Date.parse(session.startedAt))
      });
      this.options.store.clearRestart(sessionId);
      this.options.store.completeRestart(auditId, "failed", reason);
      this.options.store.appendEvent(sessionId, "error", reason, new Date(this.now()));
      this.options.notifications?.set({
        key: `run:restart:${sessionId}`,
        severity: "error",
        message: `${session.modelId} could not restart. ${reason}`,
        route: `/models?run=${sessionId}`,
        dismissible: true
      });

      const settled = this.refresh(runtime).session;
      const config = this.runtimeConfig(sessionId) ?? {
        current: effective.current,
        defaults: effective.defaults,
        contextWindowMax: effective.contextWindowMax,
        contextWindowMaxSource: effective.contextWindowMaxSource,
        concurrencyMax: limits.concurrencyMax,
        estimatedMaxContext: limits.estimatedMaxContext,
        fits: true,
        restart: null
      };

      return { status: "failed", session: settled, config, reason };
    };

    try {
      await this.options.compute.destroyInstance(instanceId);

      // Creating before this confirmation would briefly bill two machines.
      if (!(await this.confirmGone(instanceId))) {
        return fail("The machine could not be confirmed released, so nothing new was rented.");
      }

      this.options.store.clearEndpoint(sessionId);
      this.options.store.beginRestart(sessionId, { ...restart, phase: "booting" });

      const created = await this.options.compute.createInstance(offer, {
        label: session.label,
        modelId: session.modelId,
        ...(runtime.apiKey ? { apiKey: runtime.apiKey } : {}),
        runtime: {
          contextWindow: values.contextWindow,
          maxConcurrentRequests: values.maxConcurrentRequests
        }
      });

      this.options.store.setInstance(sessionId, created.instanceId, offer.offerId);
      runtime.session = { ...runtime.session, instanceId: created.instanceId, state: "provisioning" };

      await this.options.compute.waitUntilReady(
        created.instanceId,
        this.options.bootCeilingMs ?? this.options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
      );

      this.options.store.transition(sessionId, "ready", {
        readyAt: new Date(this.now()).toISOString()
      });
      this.options.store.transition(sessionId, "active");
      this.options.store.recordRuntimeConfig(sessionId, {
        current: values,
        defaults: effective.defaults,
        contextWindowMax: effective.contextWindowMax,
        contextWindowMaxSource: effective.contextWindowMaxSource
      });
      this.options.store.clearRestart(sessionId);
      this.options.store.completeRestart(auditId, "succeeded");

      const mapped = this.options.compute.resolveEndpoint?.(created.instanceId);
      if (mapped) {
        this.options.store.recordEndpoint(sessionId, mapped.host, mapped.port);
      }

      this.options.store.appendEvent(
        sessionId,
        "info",
        `Restart complete. The model is serving with a ${values.contextWindow.toLocaleString()}-token context.`,
        new Date(this.now())
      );
      this.options.notifications?.set({
        key: `run:restart:${sessionId}`,
        severity: "success",
        message: `${session.modelId} restarted with a ${values.contextWindow.toLocaleString()}-token context.`,
        ...(mapped
          ? {
              endpoint: {
                baseUrl: `http://${mapped.host}:${mapped.port}/v1`,
                host: mapped.host,
                port: mapped.port,
                modelId: session.modelId
              }
            }
          : {}),
        route: `/models?run=${sessionId}`,
        dismissible: true
      });

      const refreshed = this.refresh(runtime).session;
      const config = this.runtimeConfig(sessionId);
      if (!config) {
        throw new SessionError("NOT_FOUND", "The restarted run could not be read back.");
      }

      return { status: "restarted", session: refreshed, config };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = fail(message);

      // The old machine is gone, so a new estimate is the only honest next step.
      try {
        const estimate = await this.createEstimate(
          session.modelId,
          30,
          session.powerTier ?? DEFAULT_POWER_TIER
        );
        return {
          status: "fresh_run_required",
          session: failed.status === "failed" ? failed.session : this.refresh(runtime).session,
          estimate,
          reason: message
        };
      } catch {
        return failed;
      }
    }
  }

  /** True once the provider no longer lists the instance (or cannot answer). */
  private async confirmGone(instanceId: number): Promise<boolean> {
    const exists = this.options.compute.instanceExists;
    if (!exists) {
      return true;
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const seen = await exists.call(this.options.compute, instanceId).catch(() => true);
      if (!seen) {
        return true;
      }
      await this.delay(300);
    }

    return false;
  }

  /**
   * How another tool reaches a running model: its mapped base URL, the model id
   * to request and the key that run was started with. Nothing is returned until
   * the server is actually serving, and the answer disappears with the run.
   */
  describeEndpoint(sessionId: string): SessionEndpoint | null {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime || !runtime.apiKey) {
      return null;
    }

    // The address is published as soon as the host maps the port, which is minutes
    // before the model serves. Waiting for "active" hid the one piece of evidence a
    // person needs while a boot is stuck or slow — and the key belongs to the run,
    // not to its state.
    const live = ["provisioning", "ready", "active"].includes(runtime.session.state);
    if (!live) {
      return null;
    }

    const instanceId = runtime.session.instanceId;
    if (instanceId === null) {
      return null;
    }

    const mapped = this.options.compute.resolveEndpoint?.(instanceId);
    if (!mapped) {
      return null;
    }

    return {
      baseUrl: `http://${mapped.host}:${mapped.port}/v1`,
      modelId: runtime.session.modelId,
      apiKey: runtime.apiKey,
      serving: true
    };
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
    messages: InferenceMessage[],
    onDelta: (kind: StreamKind, text: string) => void,
    images: InferenceImage[] = []
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

    // A text model would silently ignore the pixels, so refuse before the GPU
    // spends tokens on a question that was never actually asked.
    if (images.length > 0 && runtime.session.capability !== "image-to-text") {
      throw new SessionError(
        "CAPABILITY_UNSUPPORTED",
        "This model only reads text. Start a model that accepts images to send one."
      );
    }

    this.touchActivity(sessionId);
    const abort = new AbortController();
    runtime.abort = abort;
    const generationStarted = this.now();

    const turn = this.options.inference
      .stream({
        sessionId,
        modelId: runtime.session.modelId,
        instanceId: runtime.session.instanceId,
        messages,
        images,
        apiKey: runtime.apiKey,
        signal: abort.signal,
        onDelta
      })
      .then((result) => {
        runtime.outputTokens += result.tokens;
        runtime.generationMs += Math.max(0, this.now() - generationStarted);
        return result;
      })
      .finally(() => {
        runtime.abort = null;
        runtime.sending = null;
        this.touchActivity(sessionId);
      });

    runtime.sending = turn;
    return turn;
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
  async reapIdle(): Promise<Session[]> {    const idleMs = this.options.idleTimeoutMinutes * 60_000;
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

  /**
   * Stops any run whose accrued cost has reached the person's per-session cap.
   *
   * This is the one bound that does not depend on somebody watching the screen:
   * the meter already exists, so the cap is a comparison, not a new mechanism
   * (FR-039). `0` means the person explicitly chose no cap.
   */
  async enforceCap(): Promise<Session[]> {
    const capMicroUsd = this.options.capMicroUsd?.() ?? 0;
    if (capMicroUsd <= 0) {
      return [];
    }

    const stopped: Session[] = [];

    for (const sessionId of [...this.runtimes.keys()]) {
      const runtime = this.runtimes.get(sessionId);
      if (!runtime || !["provisioning", "ready", "active"].includes(runtime.session.state)) {
        continue;
      }

      const startedMs = Date.parse(runtime.session.startedAt);
      const elapsedHours = Math.max(0, this.now() - startedMs) / 3_600_000;
      const accrued = Math.round(elapsedHours * runtime.session.hourlyRateMicroUsd);
      if (accrued < capMicroUsd) {
        continue;
      }

      this.options.store.appendEvent(
        sessionId,
        "warn",
        `Reached the ${(capMicroUsd / 1_000_000).toFixed(2)} USD spending cap. Releasing the GPU.`,
        new Date(this.now())
      );

      const ended = await this.end(sessionId, "cap").catch((error: unknown) => {
        this.options.logger?.warn("Could not stop a run at its cap", {
          sessionId,
          message: error instanceof Error ? error.message : String(error)
        });
        return null;
      });

      if (ended) {
        stopped.push(ended);
      }
    }

    return stopped;
  }

  async end(sessionId: string, reason: NonNullable<Session["endReason"]>): Promise<Session | null> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      // A store-backed fallback: the run may have been adopted after a restart, or
      // started by a previous process. "Stop" must still release the machine and
      // close the record instead of doing nothing.
      return this.endFromStore(sessionId, reason);
    }

    this.options.store.transition(sessionId, "ending");
    runtime.abort?.abort();
    const beforeEnd = this.options.store.get(sessionId);
    this.options.store.appendEvent(
      sessionId,
      "info",
      reason === "idle" ? "Releasing the GPU after the idle timeout" : "Releasing the GPU",
      new Date(this.now())
    );

    if (runtime.session.instanceId !== null) {
      const release = await this.release(runtime.session.instanceId);
      if (release === "unconfirmed") {
        // The machine may still be billing. A run that says "terminated" while the
        // provider still charges for it is the one thing this product must never
        // show, so the record stays open and stoppable until the release lands.
        this.options.store.transition(sessionId, "ending");
        this.pendingReleases.set(sessionId, runtime.session.instanceId);
        this.startReleaseRetry();
        throw new SessionError(
          "PROVIDER_UNAVAILABLE",
          "The GPU could not be confirmed released; it is still marked as running so you can retry stopping it."
        );
      }
    }

    this.options.store.transition(sessionId, reason === "failure" ? "failed" : "ended", {
      endedAt: new Date(this.now()).toISOString(),
      endReason: reason
    });

    // The address, the readiness notice and the release record all die with the
    // run: a link that no longer works is worse than no link (FR-013/FR-017).
    this.options.notifications?.clear(`run:ready:${sessionId}`);
    this.options.store.clearEndpoint(sessionId);
    this.options.store.recordRelease(sessionId, {
      reason: releaseReasonForEnd(reason),
      phase: beforeEnd?.boot?.text ?? null,
      elapsedMs: Math.max(0, this.now() - Date.parse(runtime.session.startedAt))
    });

    const ended = this.options.store.get(sessionId);
    if (ended) {
      this.recordMetrics(runtime, ended, metricOutcome(reason));
      this.options.onRunFinished?.(ended);
    }
    this.pendingReleases.delete(sessionId);
    this.runtimes.delete(sessionId);
    return ended;
  }

  /**
   * Releases one instance and says whether that is certain.
   *
   * `released` covers "destroyed" and "already gone"; `unconfirmed` means the
   * provider refused or was unreachable *and* still lists the machine, which is the
   * only case where money may be flowing without a run to show for it.
   */
  private async release(instanceId: number): Promise<"released" | "unconfirmed"> {
    try {
      await this.options.compute.destroyInstance(instanceId);
      return "released";
    } catch (error) {
      this.options.logger?.warn("Instance teardown failed; keeping the run open", {
        instanceId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const exists = await this.options.compute.instanceExists?.(instanceId).catch(() => true);

    // No way to ask the provider: assume the worst and keep the run open. A phantom
    // "terminated" costs somebody money; a phantom "running" costs a Stop click.
    return exists === false ? "released" : "unconfirmed";
  }

  /**
   * Retries the releases that could not be confirmed, until they are.
   *
   * Runs once a minute while anything is pending, and stops when the list empties,
   * so a provider outage delays a teardown instead of losing it.
   */
  private startReleaseRetry(): void {
    if (this.releaseTimer !== null) {
      return;
    }

    this.releaseTimer = setInterval(() => {
      void this.retryPendingReleases();
    }, 60_000);
    this.releaseTimer.unref?.();
  }

  private async retryPendingReleases(): Promise<void> {
    for (const [sessionId, instanceId] of [...this.pendingReleases]) {
      if ((await this.release(instanceId)) === "unconfirmed") {
        continue;
      }

      this.pendingReleases.delete(sessionId);
      const stored = this.options.store.get(sessionId);
      if (stored && ["ending", "active", "ready", "estimated", "provisioning"].includes(stored.state)) {
        this.options.store.transition(sessionId, "ended", {
          endedAt: new Date(this.now()).toISOString(),
          endReason: "reconciled"
        });
      }
      this.runtimes.delete(sessionId);
      this.options.logger?.warn("Released a GPU after a retry", { sessionId, instanceId });
    }

    if (this.pendingReleases.size === 0 && this.releaseTimer !== null) {
      clearInterval(this.releaseTimer);
      this.releaseTimer = null;
    }
  }

  /**
   * Ends a run this process is not currently driving.
   *
   * The instance id is on the row, so the machine can still be released; without
   * this a Stop on a run from an earlier process would answer "nothing to stop"
   * while the GPU kept billing.
   */
  private async endFromStore(
    sessionId: string,
    reason: NonNullable<Session["endReason"]>
  ): Promise<Session | null> {
    const stored = this.options.store.get(sessionId);
    if (!stored || !["estimated", "provisioning", "ready", "active", "ending"].includes(stored.state)) {
      return null;
    }

    if (stored.instanceId !== null) {
      const release = await this.release(stored.instanceId);
      if (release === "unconfirmed") {
        this.pendingReleases.set(sessionId, stored.instanceId);
        this.startReleaseRetry();
        throw new SessionError(
          "PROVIDER_UNAVAILABLE",
          "The GPU could not be confirmed released; it is still marked as running so you can retry stopping it."
        );
      }
    }

    this.options.store.appendEvent(
      sessionId,
      "info",
      "Releasing the GPU",
      new Date(this.now())
    );
    this.options.store.transition(sessionId, reason === "failure" ? "failed" : "ended", {
      endedAt: new Date(this.now()).toISOString(),
      endReason: reason
    });

    return this.options.store.get(sessionId);
  }

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
        const release = await this.release(orphan.instanceId);
        if (release === "unconfirmed") {
          // Money may still be flowing. Keep the row open — and therefore visible and
          // stoppable — and retry the release instead of declaring it ended.
          this.pendingReleases.set(orphan.id, orphan.instanceId);
          this.options.logger?.warn("Could not release an orphaned instance; keeping it visible", {
            sessionId: orphan.id,
            instanceId: orphan.instanceId
          });
          continue;
        }
      }

      this.options.store.transition(orphan.id, "ended", {
        endedAt: new Date(this.now()).toISOString(),
        endReason: "reconciled"
      });
      this.runtimes.delete(orphan.id);
      reconciled += 1;
    }

    if (this.pendingReleases.size > 0) {
      this.startReleaseRetry();
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
