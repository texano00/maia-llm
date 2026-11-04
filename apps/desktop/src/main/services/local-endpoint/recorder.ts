import type { HistoryRepository } from "../history/repository";
import type { RecordedTurn } from "./server";

/**
 * Writes IDE traffic into the same history as in-app chat, separated per client.
 *
 * Assistants send one request at a time with no conversation id, so each client
 * (Continue, Cline, the `ollama` CLI…) gets its own conversation per session
 * instead of interleaving prompts from different tools in one transcript.
 */
export function createTurnRecorder(history: HistoryRepository) {
  const conversations = new Map<string, string>();

  return (turn: RecordedTurn): void => {
    try {
      const key = `${turn.sessionId}:${turn.client}`;
      let conversationId = conversations.get(key);

      if (!conversationId) {
        const shortName = turn.modelId.split("/").at(-1) ?? turn.modelId;
        conversationId = history.createConversation({
          title: `${turn.client.slice(0, 60)} · ${shortName}`.slice(0, 200),
          modelId: turn.modelId,
          origin: "ide",
          clientLabel: turn.client,
          sessionId: turn.sessionId
        }).id;
        conversations.set(key, conversationId);
      }

      history.appendMessage({
        conversationId,
        role: "user",
        content: turn.prompt
      });

      // The repository refuses an empty assistant message unless it is marked
      // interrupted, which is exactly the case when a client disconnects.
      if (turn.answer.length > 0 || turn.interrupted) {
        history.appendMessage({
          conversationId,
          role: "assistant",
          content: turn.answer,
          reasoning: turn.thinking.length > 0 ? turn.thinking : null,
          completionTokens: turn.tokens > 0 ? turn.tokens : null,
          interrupted: turn.interrupted
        });
      }
    } catch {
      // History is a convenience here: a storage hiccup must not fail the answer
      // an editor is already streaming.
    }
  };
}
