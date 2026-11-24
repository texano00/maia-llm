import type { SessionState } from "@maia/contracts";

/**
 * The Models view may only ever show these statuses (FR-003). Internal
 * lifecycle states are richer, so the renderer projects them here instead of
 * exposing `session.state` directly.
 *
 * `stopping` exists because a release that could not be confirmed is neither
 * running nor terminated: the machine may still be billing, so saying
 * "terminated" would be the one lie this product cannot tell.
 */
export type VisibleStatus = "initializing" | "running" | "stopping" | "terminated";

const VISIBLE_BY_STATE: Record<SessionState, VisibleStatus> = {
  estimated: "initializing",
  provisioning: "initializing",
  ready: "initializing",
  active: "running",
  ending: "stopping",
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
 * is still initializing and one whose release was not yet confirmed. A boot that
 * never finishes, or a teardown the provider did not acknowledge, is exactly when
 * somebody wants the Stop button.
 */
export function isStoppable(state: SessionState): boolean {
  return (
    state === "estimated" ||
    state === "provisioning" ||
    state === "ready" ||
    state === "active" ||
    state === "ending"
  );
}
