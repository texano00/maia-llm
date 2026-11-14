import type { SessionState } from "@maia/contracts";

/**
 * The Models view may only ever show these three statuses (FR-003). Internal
 * lifecycle states are richer, so the renderer projects them here instead of
 * exposing `session.state` directly.
 */
export type VisibleStatus = "initializing" | "running" | "terminated";

const VISIBLE_BY_STATE: Record<SessionState, VisibleStatus> = {
  estimated: "initializing",
  provisioning: "initializing",
  ready: "initializing",
  active: "running",
  ending: "terminated",
  ended: "terminated",
  cancelled: "terminated",
  failed: "terminated"
};

export function toVisibleStatus(state: SessionState): VisibleStatus {
  return VISIBLE_BY_STATE[state];
}

/**
 * Chat may only use a serving run. Every other state — including `ending` — is
 * either not serving yet or already unavailable, so it is never offered there.
 */
export function isChatEligible(state: SessionState): boolean {
  return state === "active";
}

/**
 * A run that can still be stopped: anything holding a machine, including one that is
 * still initializing. A boot that never finishes is exactly when somebody wants the
 * Stop button.
 */
export function isStoppable(state: SessionState): boolean {
  return (
    state === "estimated" ||
    state === "provisioning" ||
    state === "ready" ||
    state === "active"
  );
}
