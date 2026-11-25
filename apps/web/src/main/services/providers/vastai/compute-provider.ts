import type { GpuFilters } from "@maia/contracts";
import type { ComputeOffer, ComputeProvider } from "../../sessions/orchestrator";
import { VLLM_IMAGE, type LaunchPlan } from "../../inference/launch-plan";
import {
  bootPercent,
  classifyFatal,
  progressSignature,
  stripAnsi,
  summarizeBootLog
} from "../../sessions/boot-log";
import {
  describeCeiling,
  isGoneStatus,
  probeInference
} from "../../sessions/readiness";
import {
  buildSearchQuery,
  classifyOffer,
  estimateDiskGb,
  estimateGpuRamGb,
  isInstanceStartFailureMessage,
  isOfferUnavailableError,
  readMappedPort,
  readPublicHost,
  toComputeOffer,
  VastAiClient,
  type VastAiInstancePayload
} from "./client";
import type { GpuOutcome, GpuReputation, ReleaseReason } from "@maia/contracts";

export interface VastComputeProviderOptions {
  getApiKey: () => Promise<string | undefined>;
  getParameterCount: (modelId: string) => Promise<number | null>;
  getHfToken?: () => Promise<string | undefined>;
  getFilters?: () => GpuFilters | undefined;
  /** Shared verdicts: machines that failed to start are skipped, good ones win ties. */
  getReputations?: () => Promise<Map<number, GpuReputation>>;
  /** Records the outcome of a provisioning attempt for every workspace to see. */
  reportOutcome?: (input: {
    machineId: number | null;
    gpuName: string;
    outcome: GpuOutcome;
    offerId?: number;
    error?: string;
  }) => Promise<void>;
  containerImage?: string;
  /** Overrides the disk size derived from the model size. */
  diskGb?: number;
  /**
   * How the model should be launched: engine, image and full argument list.
   * Falls back to handing the model id to vLLM's `--model`.
   */
  getModelPlan?: (
    modelId: string,
    offer: ComputeOffer,
    contextScale?: number,
    apiKey?: string,
    runtime?: { contextWindow?: number; maxConcurrentRequests?: number }
  ) => Promise<LaunchPlan>;
  /**
   * The per-attempt ceiling in minutes, used for the *report* that says a boot
   * is taking longer than disclosed. It never releases the machine (FR-037).
   */
  readyTimeoutMs?: number;
  /** How often the person is reminded while a run sits past the ceiling. */
  reminderIntervalMs?: number;
  /** No progress for this long ends the attempt with `no_progress`. */
  quietWindowMs?: number;
  /**
   * Silence budget once the container is running.
   *
   * A GGUF download can be quiet for half an hour — llama.cpp buffers its
   * progress bar and Docker writes nothing until a newline — so the pre-container
   * budget would release a perfectly healthy download (feature 011 follow-up).
   */
  runningQuietWindowMs?: number;
  /** How long one log read may block the wait; a vast.ai log can take a minute. */
  logFetchTimeoutMs?: number;
  /**
   * How often the current phase is reported while the model loads. The run card
   * treats a phase older than a minute as "not current", so silence here turns a
   * healthy boot into "waiting for the machine to report progress".
   */
  phaseReportIntervalMs?: number;
  /** How often the container tail is read for progress, phase and fatal errors. */
  logIntervalMs?: number;
  /**
   * How long a host may sit on the request without ever starting the container
   * before it is treated as stuck. Ignored once the container has started:
   * from then on the work is real and only `readyTimeoutMs` applies.
   */
  stallTimeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * How often a quiet boot still reports its elapsed time. vLLM binds its port
   * only after the weights are loaded, so a 27B model looks dead for ten
   * minutes unless the wait says something.
   */
  progressIntervalMs?: number;
  /**
   * While the model server is loading, how often the instance itself is
   * re-checked. A crashed engine core closes the port, so a container that
   * exited is otherwise indistinguishable from "still loading".
   */
  aliveCheckIntervalMs?: number;
  /** How long a running container may stay portless before it is reported as broken. */
  missingPortTimeoutMs?: number;
  /**
   * How long a fresh instance may report no status at all.
   *
   * `actual_status` is null until the host checks in, and on a busy host that can
   * take several minutes — the image is multi-gigabyte. Treating two minutes of
   * silence as "never became visible" released healthy machines mid-pull, and each
   * retry rented another GPU for the same wait.
   */
  unknownStatusTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Injectable clock and pause, so timeout behaviour can be tested. */
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to a live client built from the stored key. */
  clientFactory?: (apiKey: string) => VastAiClient;
  logger?: { info(message: string, context?: Record<string, unknown>): void; warn(message: string, context?: Record<string, unknown>): void } | undefined;
}

export interface InstanceEndpoint {
  host: string;
  port: number;
}

export interface ProvisioningProgress {
  /** vast.ai instance status: scheduling, loading, running… */
  status: string;
  /** Provider message for that status, when it sends one. */
  message: string | null;
  elapsedMs: number;
}

/** The container can never start on this host; another machine must be booked. */
export class InstanceStartError extends Error {
  constructor(
    message: string,
    public readonly instanceId: number,
    public readonly releaseReason: ReleaseReason = "start_failed"
  ) {
    super(message);
    this.name = "InstanceStartError";
  }
}

/**
 * The host never reported in, never started the container, or never opened its
 * port. Nothing is wrong with the request, so another machine is worth a try;
 * unlike `InstanceStartError` this does not blacklist the host for everyone.
 */
export class InstanceStartTimeoutError extends Error {
  constructor(
    message: string,
    public readonly instanceId: number,
    public readonly releaseReason: ReleaseReason = "no_progress"
  ) {
    super(message);
    this.name = "InstanceStartTimeoutError";
  }
}

/**
 * Real vast.ai provisioning. Instances are created from the chosen offer with a
 * vLLM container, labelled `maia:<install>:<session>`, and destroyed on teardown.
 */
export function createVastComputeProvider(options: VastComputeProviderOptions): ComputeProvider & {
  resolveEndpoint(instanceId: number): InstanceEndpoint | null;
  listLabelledInstances(prefix: string): Promise<Array<{ instanceId: number; label: string }>>;
} {
  const endpoints = new Map<number, InstanceEndpoint>();
  /** What a probe needs that only `createInstance` knows. */
  const bootContext = new Map<number, { modelId: string; apiKey: string }>();

  async function client(): Promise<VastAiClient> {
    const key = await options.getApiKey();
    if (!key) {
      throw new Error("Add your vast.ai API key in Settings before renting a GPU.");
    }

    return options.clientFactory ? options.clientFactory(key) : new VastAiClient(key);
  }

  return {
    resolveEndpoint(instanceId: number): InstanceEndpoint | null {
      return endpoints.get(instanceId) ?? null;
    },

    isOfferUnavailable(error: unknown): boolean {
      return isOfferUnavailableError(error);
    },

    isUnrecoverable(error: unknown): boolean {
      return error instanceof InstanceStartError;
    },

    isRetryableStartup(error: unknown): boolean {
      // Both mean "this machine could not get the model running". A bad request
      // fails in createInstance and an auth/network error repeats everywhere, so
      // neither should burn the retry budget on more hosts.
      return error instanceof InstanceStartError || error instanceof InstanceStartTimeoutError;
    },

    async reportOutcome(input) {
      await options.reportOutcome?.(input);
    },

    async findOffer({ modelId, filters, excludeOfferIds, excludeMachineIds }): Promise<ComputeOffer | null> {
      const api = await client();
      const parameterCount = await options.getParameterCount(modelId);
      const gpuRamGb = estimateGpuRamGb(parameterCount);
      const diskGb = options.diskGb ?? estimateDiskGb(parameterCount);
      const effectiveFilters = filters ?? options.getFilters?.();
      const excluded = new Set(excludeOfferIds ?? []);
      const excludedMachines = new Set(excludeMachineIds ?? []);

      const offers = await api.searchOffers(
        buildSearchQuery({
          gpu_ram_gb: gpuRamGb,
          maxHourlyMicroUsd: effectiveFilters?.maxHourlyMicroUsd ?? null,
          filters: effectiveFilters,
          minDiskGb: diskGb
        })
      );

      // Offers whose machine is not rentable stay listed but cannot be booked;
      // asking for one answers `400 no_such_ask`. Slow hosts are dropped by the
      // configured startup gates, and Volta cards cannot run vLLM at all.
      const verdicts = new Map(offers.map((offer) => [offer.id, classifyOffer(offer, effectiveFilters)]));
      const bookable = offers.filter((offer) => verdicts.get(offer.id) === "bookable");
      const rejected = { notRentable: 0, unsupportedCapability: 0, tooSlow: 0 };
      for (const verdict of verdicts.values()) {
        if (verdict === "not-rentable") rejected.notRentable += 1;
        if (verdict === "unsupported-capability") rejected.unsupportedCapability += 1;
        if (verdict === "too-slow") rejected.tooSlow += 1;
      }

      // Shared reputation: a machine that failed to start is never rented again
      // while its verdict is fresh, and known-good machines win ties on price.
      const reputations = (await options.getReputations?.()) ?? new Map<number, GpuReputation>();
      const unstable = new Set(
        [...reputations.values()]
          .filter((record) => record.status === "unstable")
          .map((record) => record.machineId)
      );
      const rank = (machineId: number | null): number => {
        if (machineId === null) {
          return 1;
        }
        const record = reputations.get(machineId);
        if (!record) {
          return 1;
        }
        return record.status === "good" ? 0 : 1;
      };

      const reliability = new Map(bookable.map((offer) => [offer.id, offer.reliability2 ?? 0]));
      const mapped = bookable
        .map(toComputeOffer)
        .filter((offer): offer is ComputeOffer => offer !== null)
        .filter((offer) => !excluded.has(offer.offerId))
        .filter((offer) => offer.machineId === null || !unstable.has(offer.machineId))
        .filter((offer) => offer.machineId === null || !excludedMachines.has(offer.machineId))
        .sort(
          (left, right) =>
            rank(left.machineId) - rank(right.machineId) ||
            left.hourlyRateMicroUsd - right.hourlyRateMicroUsd ||
            (reliability.get(right.offerId) ?? 0) - (reliability.get(left.offerId) ?? 0)
        );

      const [best] = mapped;
      options.logger?.info("vast.ai offer search finished", {
        modelId,
        gpuRamGb,
        diskGb,
        listed: offers.length,
        bookable: bookable.length,
        rejected,
        excluded: excluded.size,
        skippedUnstable: bookable.filter((offer) =>
          offer.machine_id !== null && offer.machine_id !== undefined
            ? unstable.has(offer.machine_id)
            : false
        ).length,
        candidates: mapped.length,
        chosenMachine: best?.machineId ?? null,
        chosenRank: best ? rank(best.machineId) : null
      });

      return best ?? null;
    },

    async createInstance(offer, context) {
      const api = await client();
      const hfToken = await options.getHfToken?.();
      const parameterCount = await options.getParameterCount(context.modelId);
      const plan = (await options.getModelPlan?.(
        context.modelId,
        offer,
        context.contextScale,
        context.apiKey,
        context.runtime
      )) ?? fallbackVllmPlan(context.modelId);

      // `onstart` only runs as a shell script under Vast's SSH/Jupyter entrypoint.
      // With `runtype: "args"` the field becomes the container command verbatim,
      // which is how `uv pip install … || python3 -m pip …` ended up as a single
      // executable name and killed the container before vLLM started.
      //
      // A plan that owns the whole process (llama.cpp narrates its own download)
      // brings the script itself: appending an `exec` to it would start a second
      // server on the same port.
      const launchScript =
        plan.launch ??
        (plan.onstart
          ? `${plan.onstart}; exec python3 -m vllm.entrypoints.openai.api_server ${plan.args
              .map(shellQuote)
              .join(" ")}`
          : null);

      const instanceId = await api.createInstance({
        offerId: offer.offerId,
        image: options.containerImage ?? plan.image,
        diskGb: options.diskGb ?? estimateDiskGb(parameterCount),
        label: context.label,
        env: {
          // Parallel ranged downloads: the weights are 15 GB for a 7B model, and
          // Hugging Face limits a single stream, so this is the difference
          // between minutes and tens of minutes on a fast host.
          HF_HUB_ENABLE_HF_TRANSFER: "1",
          // llama.cpp's own downloader reads HF_TOKEN; the vLLM images read the
          // long form. Setting both costs nothing and gated repositories need
          // whichever engine ends up running.
          ...(hfToken ? { HF_TOKEN: hfToken, HUGGING_FACE_HUB_TOKEN: hfToken } : {}),
          ...plan.env
        },
        ...(launchScript
          ? { runtype: "ssh_direct" as const, onstart: launchScript }
          : { runtype: "args" as const, args: plan.args }),
        port: 8000
      });

      options.logger?.info("vast.ai instance requested", {
        instanceId,
        offerId: offer.offerId,
        engine: plan.engine,
        image: options.containerImage ?? plan.image,
        quantization: plan.quantization ?? null,
        contextLength: plan.limits?.maxModelLen ?? null,
        weightsGb: Math.round(plan.weightsGb * 10) / 10
      });
      bootContext.set(instanceId, { modelId: context.modelId, apiKey: context.apiKey ?? "" });
      return { instanceId };
    },

    async getInstanceLogs(instanceId) {
      const api = await client();
      return api.getInstanceLogs(instanceId);
    },

    async waitUntilReady(instanceId, timeoutMs, onProgress) {
      const api = await client();
      const now = options.now ?? (() => Date.now());
      const pause = options.pause ?? sleep;
      const pollInterval = options.pollIntervalMs ?? 5_000;
      const startedAt = now();
      /** A report point, never a release trigger (FR-037). */
      const ceiling = options.readyTimeoutMs ?? timeoutMs;
      const reminderIntervalMs = options.reminderIntervalMs ?? 10 * 60_000;
      const progressIntervalMs = options.progressIntervalMs ?? 60_000;
      const quietWindowMs = options.quietWindowMs ?? 15 * 60_000;
      const runningQuietWindowMs = options.runningQuietWindowMs ?? 45 * 60_000;
      const logIntervalMs = options.logIntervalMs ?? 20_000;
      const logFetchTimeoutMs = options.logFetchTimeoutMs ?? 5_000;
      const aliveCheckIntervalMs = options.aliveCheckIntervalMs ?? 15_000;
      const missingPortTimeoutMs = options.missingPortTimeoutMs ?? 90_000;
      const unknownStatusTimeoutMs = options.unknownStatusTimeoutMs ?? 12 * 60_000;
      // Reports on the run card's own scale: the card calls a phase older than a
      // minute "not current", so an unreported-but-alive boot looks stalled.
      const phaseReportIntervalMs = options.phaseReportIntervalMs ?? 30_000;
      const context = bootContext.get(instanceId) ?? { modelId: "", apiKey: "" };

      let lastStatus = "";
      let lastMessage = "";
      let lastProgressAt = startedAt;
      let lastReportAt = startedAt;
      let lastLogAt = -logIntervalMs;
      let lastAliveCheckAt = -aliveCheckIntervalMs;
      let lastSignature = "";
      let phase: string | null = null;
      let lastPercent: number | null = null;

      /** Human sentence for the phase, percent included when the log has one. */
      const describePhase = (): string => {
        if (!phase && lastPercent === null) {
          // Nothing observed yet: an empty message keeps the product from
          // persisting a placeholder as if it were the container's own words.
          return "";
        }

        const base = phase ?? "loading the model";
        return lastPercent === null ? base : `${base} (${lastPercent}%)`;
      };
      let ceilingReportedAt: number | null = null;
      let unknownSince: number | null = null;
      let runningWithoutPortSince: number | null = null;
      // The engine's own sentence from a probe that was answered but not served.
      let engineDetail: string | null = null;
      let lastPhaseReportAt = 0;
      // Once the container is up the host is doing real work: pulling the image,
      // then downloading weights. That phase gets the full quiet window instead
      // of being cancelled for "looking quiet".
      let containerStarted = false;

      /**
       * Reads the tail on its own cadence. The provider's status line says
       * "running" for the whole download, so this is the signal that actually
       * moves — and the only place a fatal error is written down.
       */
      const inspectLog = (log: string | null): void => {
        if (!log) {
          return;
        }

        const signature = progressSignature(log);
        if (signature !== lastSignature) {
          lastSignature = signature;
          lastProgressAt = now();
        }

        const summarised = summarizeBootLog(log);
        if (summarised) {
          phase = summarised;
        }

        const percent = bootPercent(log);
        if (percent !== null) {
          lastPercent = percent;
        }

        const fatal = classifyFatal(log, null);
        if (fatal) {
          throw new InstanceStartError(fatal.detail, instanceId, fatal.reason);
        }
      };

      for (;;) {
        const instance = await api.getInstance(instanceId);
        const status = instanceStatus(instance);
        const message = instance.status_msg ?? "";

        // A host that cannot attach the GPU never recovers: stop waiting for it.
        if (isInstanceStartFailureMessage(instance.status_msg)) {
          throw new InstanceStartError(
            `The container could not start on this machine: ${instance.status_msg}`,
            instanceId
          );
        }

        // Any change in status or provider message is progress worth reporting
        // and worth extending the stall window for.
        if (status !== lastStatus || message !== lastMessage) {
          lastStatus = status;
          lastMessage = message;
          lastProgressAt = now();
          lastReportAt = now();
          onProgress?.({
            status,
            message: message.length > 0 ? message : null,
            elapsedMs: now() - startedAt
          });
        } else if (now() - lastReportAt >= progressIntervalMs) {
          // Nothing changed, but the boot is alive: say so rather than let the
          // log sit silent for the whole weight download.
          lastReportAt = now();
          onProgress?.({
            status,
            message: message.length > 0 ? message : null,
            elapsedMs: now() - startedAt
          });
        }

        // A freshly created instance reports `unknown` until the host reports
        // back, so only a persistent unknown/offline is fatal — and "persistent"
        // has to outlast a slow image pull, or the retry loop rents GPU after GPU
        // for the same wait.
        if (status === "unknown" || status === "offline") {
          unknownSince ??= now();
          if (now() - unknownSince > unknownStatusTimeoutMs) {
            throw new InstanceStartTimeoutError(
              `The GPU instance never became visible (${status}) after ${Math.round(
                (now() - startedAt) / 60_000
              )} minutes.`,
              instanceId,
              "instance_gone"
            );
          }
        } else {
          unknownSince = null;
        }

        if (["exited", "error", "destroyed"].includes(status)) {
          throw new InstanceStartTimeoutError(
            `The GPU instance stopped while starting up (${status}).`,
            instanceId,
            "instance_gone"
          );
        }

        if (status === "running") {
          containerStarted = true;
          const host = readPublicHost(instance);
          const port = readMappedPort(instance);
          if (host && port) {
            endpoints.set(instanceId, { host, port });
            const endpoint = `http://${host}:${port}`;
            onProgress?.({ status: "starting", message: endpoint, elapsedMs: now() - startedAt });

            // The port opens long before the model serves, so the loop below is
            // the wait: probe inference, read the tail for progress and fatal
            // errors, and never decide anything from elapsed time alone.
            for (;;) {
              const elapsedMs = now() - startedAt;

              if (elapsedMs - lastLogAt >= logIntervalMs) {
                lastLogAt = elapsedMs;
                const reading = api.getInstanceLogs
                  ? api.getInstanceLogs(instanceId, { tail: 80 }).catch(() => null)
                  : Promise.resolve(null);

                // A log read must never be what delays the probe: vast.ai builds
                // the log on demand and can take a minute. The read keeps going
                // in the background; this iteration just does not wait for it.
                const log = await Promise.race([
                  reading,
                  new Promise<null>((resolve) => {
                    const timer = setTimeout(() => resolve(null), logFetchTimeoutMs);
                    timer.unref?.();
                  })
                ]);
                inspectLog(log);
              }

              const probe = await probeInference({
                baseUrl: endpoint,
                modelId: context.modelId,
                apiKey: context.apiKey,
                ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
              });

              if (probe.kind === "serving") {
                options.logger?.info("Model server is serving", {
                  instanceId,
                  port,
                  models: probe.models
                });
                onProgress?.({
                  status: "serving",
                  message: `${endpoint} (${probe.models.join(", ")})`,
                  elapsedMs: now() - startedAt
                });
                return;
              }

              if (probe.kind === "failed") {
                throw new InstanceStartError(probe.detail, instanceId, probe.reason);
              }

              // A llama.cpp download can write nothing for half an hour (its
              // progress bar is buffered), while the engine already answers
              // "Loading model". That answer is the evidence the log withholds,
              // so it is reported on a cadence: the run card stays current and
              // says what the engine says instead of going quiet.
              if (probe.kind === "waiting" && probe.answered && probe.detail) {
                engineDetail = probe.detail;
              }

              if (now() - lastPhaseReportAt >= phaseReportIntervalMs) {
                lastPhaseReportAt = now();
                const message = describePhase() || engineDetail;
                if (message) {
                  onProgress?.({ status: "starting", message, elapsedMs: now() - startedAt });
                }
              }

              // A crashed engine core closes the port, so the instance is asked
              // directly; one report is never enough to end the attempt.
              if (elapsedMs - lastAliveCheckAt >= aliveCheckIntervalMs) {
                lastAliveCheckAt = elapsedMs;
                const current = await api.getInstance(instanceId).catch(() => null);
                if (!current) {
                  throw new InstanceStartTimeoutError(
                    "The GPU instance disappeared while the model was loading. The GPU was released.",
                    instanceId,
                    "instance_gone"
                  );
                }

                const state = instanceStatus(current);
                if (isGoneStatus(state)) {
                  throw new InstanceStartTimeoutError(
                    `The model container stopped while loading the model (vast.ai reported "${state}"${
                      current.status_msg ? `: ${current.status_msg}` : ""
                    }). The GPU was released.`,
                    instanceId,
                    "instance_gone"
                  );
                }
              }

              if (now() - lastProgressAt > runningQuietWindowMs) {
                throw new InstanceStartTimeoutError(
                  `The machine made no progress for ${Math.round(runningQuietWindowMs / 60_000)} min${
                    phase ? ` (last: ${phase})` : ""
                  }. The GPU was released.`,
                  instanceId,
                  "no_progress"
                );
              }

              // The ceiling is reported, never acted on: the person decides
              // whether the wait is still worth its cost (FR-037).
              const pastCeiling = now() - startedAt >= ceiling;
              const reminderDue =
                ceilingReportedAt !== null && now() - ceilingReportedAt >= reminderIntervalMs;
              if ((pastCeiling && ceilingReportedAt === null) || reminderDue) {
                ceilingReportedAt = now();
                onProgress?.({
                  status: "ceiling",
                  message: describeCeiling({
                    elapsedMs: now() - startedAt,
                    ceilingMs: ceiling,
                    phase: describePhase()
                  }),
                  elapsedMs: now() - startedAt
                });
              }

              if (now() - lastReportAt >= progressIntervalMs) {
                lastReportAt = now();
                onProgress?.({
                  status: "starting",
                  message: describePhase(),
                  elapsedMs: now() - startedAt
                });
              }

              await pause(pollInterval);
            }
          }

          // Running with no port means the Docker mapping never applied — the
          // model is up but unreachable, which looks like "nothing happened".
          runningWithoutPortSince ??= now();
          if (now() - runningWithoutPortSince > missingPortTimeoutMs) {
            throw new InstanceStartTimeoutError(
              "The container is running but vast.ai published no port for 8000, so the model cannot be reached. The Docker port mapping did not apply to this instance.",
              instanceId,
              "port_not_published"
            );
          }
        } else {
          runningWithoutPortSince = null;

          // A host that never even starts the container is not slow, it is
          // stuck: say so instead of waiting out the quiet window in silence.
          if (!containerStarted && now() - lastProgressAt > quietWindowMs) {
            throw new InstanceStartTimeoutError(
              `The GPU host did not start the container within ${Math.round(
                quietWindowMs / 60_000
              )} min and reported no progress (last status: "${lastStatus}"). The GPU was released.`,
              instanceId,
              "no_progress"
            );
          }
        }

        await pause(pollInterval);
      }
    },

    /**
     * Whether vast.ai still lists this machine.
     *
     * `getInstance` throws when the instance is not visible any more, which is the
     * same question asked from the other side.
     */
    async instanceExists(instanceId) {
      const api = await client();
      try {
        await api.getInstance(instanceId);
        return true;
      } catch {
        return false;
      }
    },

    async destroyInstance(instanceId) {
      endpoints.delete(instanceId);      bootContext.delete(instanceId);      const api = await client();
      await api.destroyInstance(instanceId);
    },

    async listLabelledInstances(prefix: string): Promise<Array<{ instanceId: number; label: string }>> {
      const api = await client();
      const instances = await api.listInstances();

      return instances
        .filter((instance) => typeof instance.id === "number")
        .map((instance) => ({ instanceId: instance.id as number, label: instance.label ?? "" }))
        .filter((instance) => instance.label.startsWith(prefix));
    }
  };
}

/**
 * Re-exported so existing callers (and tests) keep importing the summariser from
 * the adapter. The implementation lives in `sessions/boot-log.ts` because the
 * orchestrator and the tally need it too.
 */
export { stripAnsi, summarizeBootLog } from "../../sessions/boot-log";

/**
 * Why the endpoint never answered, told apart by the container's own log.
 *
 * "Still loading" and "listening inside the container but unreachable from
 * here" look identical to an HTTP probe and have nothing to do with each other:
 * the first is patience, the second is a host that does not publish the port
 * (vast.ai shows such an instance as *running, but no web interface*). Naming
 * the difference is what stops the next person from re-renting the same host.
 */
export async function describeSilentServer(
  api: VastAiClient,
  instanceId: number,
  endpoint: string
): Promise<string> {
  let logs: string | null = null;
  try {
    logs = await api.getInstanceLogs(instanceId, { tail: 80 });
  } catch {
    logs = null;
  }

  if (logs && /listening on https?:\/\//i.test(stripAnsi(logs))) {
    return `The model server is running inside the container, but ${endpoint} never answered from here: the host is not publishing port 8000 to the internet. The GPU was released — another host is needed.`;
  }

  return "The model server did not become ready in time. The GPU was released — a cold start can take several minutes when the host is slow.";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The status of an instance, from whichever field the host actually filled in.
 *
 * `actual_status` is the container's state and `cur_state` is the lifecycle
 * state vast.ai tracks; some hosts leave the first null for the whole boot
 * (observed on machine 78466, where `cur_state` said `running` while
 * `actual_status` stayed null). Reading only the first field made a working
 * container look like it had never reported in, which released it and rented
 * another GPU to repeat the same wait.
 */
function instanceStatus(instance: VastAiInstancePayload): string {
  return instance.actual_status ?? instance.cur_state ?? "unknown";
}

/** Used when no plan resolver is wired (tests, or a very old composition root). */
function fallbackVllmPlan(modelId: string): LaunchPlan {
  return {
    engine: "vllm",
    image: VLLM_IMAGE,
    args: [
      "--model",
      modelId,
      "--port",
      "8000",
      "--served-model-name",
      modelId,
      "--enforce-eager",
      "--disable-log-requests"
    ],
    env: {},
    gguf: false,
    weightsGb: 0
  };
}

/**
 * POSIX quoting for values inserted into the container's startup script. Model
 * ids are usually safe, but a repository name may contain characters the shell
 * would eat (`&`, `;`, spaces).
 */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}
