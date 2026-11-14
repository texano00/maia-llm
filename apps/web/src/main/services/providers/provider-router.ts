import type {
  ComputeProvider,
  InferenceRuntime,
  ProvisioningProgress
} from "../sessions/orchestrator";
import { SessionError } from "../sessions/orchestrator";

/**
 * The two backends a deployment can run: rented machines, or the simulated one.
 *
 * `mode: "live"` only says what the deployment *intends*; whether a live rental
 * is possible depends on the key that is saved right now. That is why the
 * decision is made per call instead of once, at startup.
 */
export interface ProviderBackend {
  compute: ComputeProvider;
  inference: InferenceRuntime;
}

export interface ProviderRouterOptions {
  /** What this deployment is configured to do. */
  mode: "live" | "mock";
  /** Whether a provider credential is saved, read on every call. */
  hasCredential: () => Promise<boolean>;
  createLive: () => ProviderBackend;
  createMock: () => ProviderBackend;
}

export interface ProviderRouter extends ProviderBackend {
  /** Which backend the next action will use. */
  mode(): Promise<"live" | "mock">;
  /** The model id the live backend would serve, for diagnostics. */
  describe(): Promise<{ mode: "live" | "mock"; reason: string | null }>;
}

/**
 * A provider error that is about the credential rather than the platform.
 *
 * `vast.ai` answers 401/403 for a key it does not accept; anything else is a
 * real outage and must keep its own message.
 */
export function isCredentialRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  if (status === 401 || status === 403) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /unauthori[sz]ed|forbidden|invalid api key|api key is invalid/i.test(message);
}

/**
 * Decides per call whether a live rental is possible.
 *
 * Two defects made this necessary. The live/mock choice was frozen when the
 * account runtime was built, so a key saved afterwards had no effect until a
 * restart; and with no key at all the mock provider answered happily, so the
 * product reported renting GPUs while renting nothing. Now the key decides, and
 * a live deployment without a key refuses and says which key is missing.
 *
 * Instances are routed by the backend that created them, so a session booked
 * before a key was removed is still destroyed through the live provider.
 */
export function createProviderRouter(options: ProviderRouterOptions): ProviderRouter {
  let live: ProviderBackend | null = null;
  let mock: ProviderBackend | null = null;
  /** The backend the last resolved action used; hooks are answered by it. */
  let current: ProviderBackend | null = null;
  const owners = new Map<number, "live" | "mock">();

  const liveBackend = (): ProviderBackend => {
    live ??= options.createLive();
    return live;
  };
  const mockBackend = (): ProviderBackend => {
    mock ??= options.createMock();
    return mock;
  };

  /** Live when configured and possible; mock when the deployment asked for it. */
  const resolve = async (): Promise<{ backend: ProviderBackend; mode: "live" | "mock" }> => {
    if (options.mode === "mock") {
      current = mockBackend();
      return { backend: current, mode: "mock" };
    }

    if (!(await options.hasCredential())) {
      throw new SessionError(
        "CREDENTIAL_MISSING",
        "No vast.ai API key is saved, so no GPU can be rented. Add the key in Settings → vast.ai."
      );
    }

    current = liveBackend();
    return { backend: current, mode: "live" };
  };

  /**
   * The provider answering verdict questions (retryable, unrecoverable, log).
   *
   * These hooks take an error, not an instance id, so they are answered by the
   * backend that produced it — which is the one the last action resolved.
   */
  const answering = (): ComputeProvider =>
    (current ?? (options.mode === "mock" ? mockBackend() : liveBackend())).compute;

  const owner = (instanceId: number): ProviderBackend | null => {
    switch (owners.get(instanceId)) {
      case "live":
        return liveBackend();
      case "mock":
        return mockBackend();
      default:
        return null;
    }
  };

  /** Calls the backend that owns the instance, or the current one if unknown. */
  const byInstance = async <T>(
    instanceId: number,
    pick: (backend: ProviderBackend) => (instanceId: number) => Promise<T>
  ): Promise<T> => {
    const known = owner(instanceId);
    if (known) {
      return pick(known)(instanceId);
    }

    const resolved = await resolve().catch(() => ({ backend: mockBackend() }));
    return pick(resolved.backend)(instanceId);
  };

  const withCredentialMapping = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (isCredentialRejection(error)) {
        throw new SessionError(
          "CREDENTIAL_INVALID",
          "vast.ai rejected the saved API key. Create a new key and save it in Settings → vast.ai."
        );
      }
      throw error;
    }
  };

  const compute: ComputeProvider = {
    async findOffer(requirements) {
      const { backend } = await resolve();
      return withCredentialMapping(() => backend.compute.findOffer(requirements));
    },

    async createInstance(offer, context) {
      const { backend, mode } = await resolve();
      const created = await withCredentialMapping(() =>
        backend.compute.createInstance(offer, context)
      );
      owners.set(created.instanceId, mode);
      return created;
    },

    waitUntilReady(instanceId: number, timeoutMs: number, onProgress?: (update: ProvisioningProgress) => void) {
      return byInstance(instanceId, (backend) => (id) =>
        backend.compute.waitUntilReady(id, timeoutMs, onProgress)
      );
    },

    destroyInstance(instanceId) {
      return byInstance(instanceId, (backend) => (id) => backend.compute.destroyInstance(id));
    },

    listLabelledInstances(prefix) {
      return resolve().then(({ backend }) =>
        backend.compute.listLabelledInstances
          ? backend.compute.listLabelledInstances(prefix)
          : Promise.resolve([])
      );
    },

    resolveEndpoint(instanceId) {
      const known = owner(instanceId);
      if (known) {
        return known.compute.resolveEndpoint?.(instanceId) ?? null;
      }

      // Unknown instance: ask the live provider, which keeps its own map.
      return options.mode === "live"
        ? (liveBackend().compute.resolveEndpoint?.(instanceId) ?? null)
        : null;
    },

    async getInstanceLogs(instanceId) {
      const owner = owners.get(instanceId);
      const backend = (owner === "mock" ? mockBackend() : owner === "live" ? liveBackend() : current ?? liveBackend()).compute;

      return backend.getInstanceLogs ? backend.getInstanceLogs(instanceId) : null;
    },

    isOfferUnavailable(error) {
      return answering().isOfferUnavailable?.(error) ?? false;
    },

    isUnrecoverable(error) {
      return answering().isUnrecoverable?.(error) ?? false;
    },

    isRetryableStartup(error) {
      const backend = answering();
      return backend.isRetryableStartup ? backend.isRetryableStartup(error) : (backend.isUnrecoverable?.(error) ?? false);
    },

    async reportOutcome(input) {
      await answering().reportOutcome?.(input);
    }
  };

  const inference: InferenceRuntime = {
    async stream(input) {
      const backend =
        input.instanceId === null ? null : owner(input.instanceId);
      return (backend ?? (await resolve()).backend).inference.stream(input);
    }
  };

  return {
    compute,
    inference,
    async mode() {
      if (options.mode === "mock") {
        return "mock";
      }
      return (await options.hasCredential()) ? "live" : "mock";
    },
    async describe() {
      if (options.mode === "mock") {
        return { mode: "mock", reason: "this deployment runs the simulated provider" };
      }
      if (await options.hasCredential()) {
        return { mode: "live", reason: null };
      }
      return { mode: "mock", reason: "no vast.ai API key is saved" };
    }
  };
}
