import type { AppSettings } from "@maia/contracts";
import { AccountRepository } from "./repository";

/**
 * One page that answers "what is going on with this person".
 *
 * The projection is a whitelist. It names every field it returns and derives the
 * rest from tables that hold no secret material, so a column added to a table
 * later cannot appear here by accident. Three things are never read: the
 * ciphertext in `credential_secrets`, conversation titles or message text (a
 * title is text the person wrote), and image paths or bytes.
 */

export interface AccountDetailQuery {
  accountId: string;
  windowDays: number;
  limit: number;
  offset: number;
}

export interface AccountDetail {
  account: {
    id: string;
    email: string;
    createdAt: string;
    lastSeenAt: string | null;
    capabilities: string[];
    activeSessions: number;
  };
  now: Array<{
    id: string;
    modelId: string;
    state: string;
    startedAt: string;
    elapsedSeconds: number;
    accruedMicroUsd: number;
    simulated: boolean;
    host: string | null;
    gpu: string | null;
  }>;
  history: {
    total: number;
    limit: number;
    offset: number;
    runs: Array<{
      id: string;
      modelId: string;
      state: string;
      endReason: string | null;
      startedAt: string;
      endedAt: string | null;
      durationSeconds: number | null;
      rateMicroUsd: number;
      simulated: boolean;
      host: string | null;
      gpu: string | null;
    }>;
  };
  usage: {
    available: boolean;
    windowDays: number;
    runs?: number;
    outputTokens?: number;
    avgTokensPerSecond?: number | null;
    spendMicroUsd?: number;
    outcomes?: Record<string, number>;
  };
  storage: {
    conversations: number;
    messages: number;
    images: number;
    oldestAt: string | null;
    newestAt: string | null;
  };
  settings: {
    appearance: string;
    catalogueMode: string;
    catalogueSupportedOnly: boolean;
    studentMode: boolean;
    gpuFilters: unknown;
    gpuStartupRetries: number;
    walletWarnThresholdMicroUsd: number;
    usageReporting: boolean;
  };
  credentials: Array<{
    provider: string;
    present: boolean;
    status: "valid" | "invalid" | "unknown";
    lastVerifiedAt: string | null;
  }>;
}

export interface AccountDetailDeps {
  repository: AccountRepository;
  /** The account's stored settings, through the same store the product uses. */
  settings: (accountId: string) => AppSettings;
  now?: () => number;
}

export function createAccountDetail(deps: AccountDetailDeps) {
  const now = deps.now ?? (() => Date.now());

  return function accountDetail(query: AccountDetailQuery): AccountDetail | null {
    const repository = deps.repository;
    const summary = repository.accountSummary(query.accountId);
    if (!summary) {
      return null;
    }

    const settings = deps.settings(query.accountId);
    const nowMs = now();
    const active = repository.activeRuns(query.accountId);
    const history = repository.historyPage(query.accountId, {
      limit: query.limit,
      offset: query.offset
    });
    const metrics = repository.sessionMetricsSummary(query.accountId, query.windowDays, nowMs);
    const storage = repository.storageCounts(query.accountId);
    const handles = repository.credentialHandles(query.accountId);

    const spendMicroUsd = repository.spendMicroUsd(query.accountId, query.windowDays, nowMs);

    return {
      account: {
        id: summary.id,
        email: summary.email,
        createdAt: summary.createdAt,
        lastSeenAt: summary.lastSeenAt,
        capabilities: [...summary.capabilities],
        activeSessions: summary.activeSessions
      },
      now: active.map((run) => {
        const startedMs = Date.parse(run.startedAt);
        const elapsedSeconds = Number.isFinite(startedMs)
          ? Math.max(0, Math.round((nowMs - startedMs) / 1000))
          : 0;

        return {
          id: run.id,
          modelId: run.modelId,
          state: run.state,
          startedAt: run.startedAt,
          elapsedSeconds,
          // Accrued, not guessed: the hourly rate times the time it has run.
          accruedMicroUsd: Math.round((run.hourlyRateMicroUsd * elapsedSeconds) / 3600),
          simulated: run.simulated,
          host: run.host,
          gpu: run.gpu
        };
      }),
      history: {
        total: history.total,
        limit: query.limit,
        offset: query.offset,
        runs: history.runs.map((run) => {
          const startedMs = Date.parse(run.startedAt);
          const endedMs = run.endedAt ? Date.parse(run.endedAt) : NaN;

          return {
            id: run.id,
            modelId: run.modelId,
            state: run.state,
            endReason: run.endReason,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            durationSeconds:
              Number.isFinite(startedMs) && Number.isFinite(endedMs)
                ? Math.max(0, Math.round((endedMs - startedMs) / 1000))
                : null,
            rateMicroUsd: run.hourlyRateMicroUsd,
            simulated: run.simulated,
            host: run.host,
            gpu: run.gpu
          };
        })
      },
      usage: settings.usageReporting
        ? {
            available: true,
            windowDays: query.windowDays,
            runs: metrics.runs,
            outputTokens: metrics.outputTokens,
            avgTokensPerSecond: metrics.tokensPerSecond,
            spendMicroUsd,
            outcomes: metrics.outcomes
          }
        : { available: false, windowDays: query.windowDays },
      storage,
      settings: {
        appearance: settings.appearance,
        catalogueMode: settings.catalogueMode,
        catalogueSupportedOnly: settings.catalogueSupportedOnly,
        studentMode: settings.studentMode,
        gpuFilters: settings.gpuFilters,
        gpuStartupRetries: settings.gpuStartupRetries,
        walletWarnThresholdMicroUsd: settings.walletWarnThresholdMicroUsd,
        usageReporting: settings.usageReporting
      },
      credentials: ["huggingface", "vastai"].map((provider) => {
        const handle = handles.find((entry) => entry.provider === provider);
        return {
          provider,
          present: handle !== undefined,
          status: handle?.status ?? "unknown",
          lastVerifiedAt: handle?.lastVerifiedAt ?? null
        };
      })
    };
  };
}
