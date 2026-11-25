import type { MessageRole } from "@maia/contracts";

export interface ContextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StoredTurn {
  role: MessageRole;
  content: string;
}

export interface BuiltContext {
  messages: ContextMessage[];
  /** Stored turns the model was not shown, so the UI can say how many. */
  omittedMessages: number;
}

/**
 * Four characters per token is the usual rough ratio for English and code. It is
 * deliberately pessimistic: over-counting shortens the context, which is safe;
 * under-counting sends a request the engine rejects.
 */
export const CHARS_PER_TOKEN = 4;
/** Leave room for the answer and for template tokens. */
export const CONTEXT_MARGIN = 0.9;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * The message array the model sees for one turn.
 *
 * Rules, in order:
 * 1. Every system notice is kept; they are short and explain a model switch.
 * 2. The newest user message is kept even when it alone exceeds the budget —
 *    dropping it would turn the request into a question nobody asked.
 * 3. Older turns are added newest-first until the budget is reached, then the
 *    array is restored to chronological order.
 *
 * The result is deterministic, so the count of omitted messages is exact.
 */
export function buildContext(
  turns: readonly StoredTurn[],
  options: { contextWindow: number }
): BuiltContext {
  const budget = Math.max(1, Math.floor(options.contextWindow * CONTEXT_MARGIN));

  const usable = turns
    .filter((turn) => turn.role === "system" || turn.role === "user" || turn.role === "assistant")
    .map((turn) => ({ role: turn.role as ContextMessage["role"], content: turn.content }))
    .filter((turn) => turn.content.length > 0 || turn.role === "assistant");

  const systems = usable.filter((turn) => turn.role === "system");
  const conversational = usable.filter((turn) => turn.role !== "system");

  let used = systems.reduce((total, turn) => total + estimateTokens(turn.content), 0);
  const kept: ContextMessage[] = [];
  let omitted = 0;

  const newestUserIndex = (() => {
    for (let index = conversational.length - 1; index >= 0; index -= 1) {
      if (conversational[index]?.role === "user") {
        return index;
      }
    }
    return -1;
  })();

  for (let index = conversational.length - 1; index >= 0; index -= 1) {
    const turn = conversational[index];
    if (!turn) {
      continue;
    }

    const cost = estimateTokens(turn.content);
    const mustKeep = index === newestUserIndex;

    if (mustKeep || used + cost <= budget) {
      kept.push(turn);
      used += cost;
    } else {
      omitted += 1;
    }
  }

  kept.reverse();

  return {
    messages: [...systems, ...kept],
    omittedMessages: omitted
  };
}
