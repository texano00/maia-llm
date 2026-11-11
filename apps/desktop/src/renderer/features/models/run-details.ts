import type { Session } from "@maia/contracts";
import { accruedMicroUsd, formatElapsed, formatUsd } from "../../shared/format";
import { toVisibleStatus, type VisibleStatus } from "./status";

/**
 * The app does not write provider-final charges to `cost_records`, so the Models
 * view must label the meter as a rate calculation, never as the final invoice.
 */
export const ACCRUED_NOTE = "Calculated at the recorded hourly rate, not a provider-final charge.";

const END_REASON_LABELS: Record<NonNullable<Session["endReason"]>, string> = {
  user: "Ended by you",
  idle: "Idle timeout",
  cap: "Spending cap reached",
  app_exit: "App exited",
  failure: "Failed",
  reconciled: "Reconciled after restart"
};

export interface RunDetails {
  visibleStatus: VisibleStatus;
  /** Formatted elapsed time, or `pending` / `unavailable` when not meaningful. */
  elapsed: string;
  durationMs: number | null;
  accruedMicroUsd: number | null;
  /** Formatted accrued cost, or `pending` / `unavailable`. */
  accrued: string;
  note: string;
  startedAt: string;
  readyAt: string | null;
  endTime: string | null;
  endReasonLabel: string | null;
  /** Startup values (runtime, cost) are not known yet. */
  valuesPending: boolean;
  /** Teardown is in progress (`ending`); final duration and cost are not stored. */
  endDetailsPending: boolean;
}

/**
 * Derives every runtime figure the Models view shows. Running runs accrue to
 * `now`; terminal runs use the persisted end timestamp so the final duration and
 * cost do not keep growing after teardown.
 */
export function describeRun(session: Session, options: { now?: number } = {}): RunDetails {
  const now = options.now ?? Date.now();
  const visibleStatus = toVisibleStatus(session.state);
  const startMs = Date.parse(session.startedAt);
  const endMs = session.endedAt ? Date.parse(session.endedAt) : null;
  const base = {
    visibleStatus,
    note: ACCRUED_NOTE,
    startedAt: session.startedAt,
    readyAt: session.readyAt,
    endTime: session.endedAt,
    endReasonLabel: session.endReason ? END_REASON_LABELS[session.endReason] : null
  };

  if (visibleStatus === "initializing") {
    return {
      ...base,
      elapsed: "pending",
      durationMs: null,
      accruedMicroUsd: null,
      accrued: "pending",
      valuesPending: true,
      endDetailsPending: false
    };
  }

  if (visibleStatus === "running") {
    const accrued = accruedMicroUsd(session.hourlyRateMicroUsd, session.startedAt, now);

    return {
      ...base,
      elapsed: formatElapsed(session.startedAt, now),
      durationMs: Math.max(0, now - startMs),
      accruedMicroUsd: accrued,
      accrued: formatUsd(accrued),
      valuesPending: false,
      endDetailsPending: false
    };
  }

  // `ending` is a teardown in progress: the run is already unavailable to Chat,
  // but no final timestamp exists yet.
  if (session.state === "ending") {
    return {
      ...base,
      endTime: null,
      elapsed: "pending",
      durationMs: null,
      accruedMicroUsd: null,
      accrued: "pending",
      valuesPending: false,
      endDetailsPending: true
    };
  }

  if (endMs === null || Number.isNaN(endMs) || Number.isNaN(startMs)) {
    return {
      ...base,
      elapsed: "unavailable",
      durationMs: null,
      accruedMicroUsd: null,
      accrued: "unavailable",
      valuesPending: false,
      endDetailsPending: false
    };
  }

  const accrued = accruedMicroUsd(session.hourlyRateMicroUsd, session.startedAt, endMs);

  return {
    ...base,
    elapsed: formatElapsed(session.startedAt, endMs),
    durationMs: Math.max(0, endMs - startMs),
    accruedMicroUsd: accrued,
    accrued: formatUsd(accrued),
    valuesPending: false,
    endDetailsPending: false
  };
}
