import type { Session } from "@maia/contracts";

/**
 * Chat only offers models that are serving right now. Everything about a run
 * that is still starting, priced or being torn down belongs to Models.
 */
export function readySessions(sessions: readonly Session[]): Session[] {
  return sessions.filter((session) => session.state === "active");
}

/** The ready session to preselect for a conversation, when its model is up. */
export function sessionForModel(
  sessions: readonly Session[],
  modelId: string | null
): Session | null {
  if (!modelId) {
    return null;
  }

  return sessions.find((session) => session.modelId === modelId) ?? null;
}

/**
 * A model to talk to when nothing is chosen yet. Chat has no other purpose than
 * using a ready model, so with one available it should not need a second click.
 */
export function defaultSession(
  sessions: readonly Session[],
  currentId: string | null
): Session | null {
  return sessions.find((session) => session.id === currentId) ?? sessions[0] ?? null;
}
