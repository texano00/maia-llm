import { z } from "zod";
import type {
  CatalogueResult,
  ConversationDetail,
  ConversationSummary,
  ModelDetail,
  Session
} from "@maia/contracts";
import {
  catalogueQuerySchema,
  chatAbortSchema,
  chatSendSchema,
  sessionEndSchema,
  sessionStartSchema,
  type ChatChunk
} from "@maia/contracts";
import type { IpcRegistry } from "./registry";
import type { CatalogueService } from "../services/catalogue/service";
import type { SessionOrchestrator } from "../services/sessions/orchestrator";
import type { HistoryRepository } from "../services/history/repository";

const modelIdSchema = z.object({ id: z.string().min(1).max(200) });

const estimateRequestSchema = z.object({
  modelId: z.string().min(1).max(200),
  expectedMinutes: z.number().int().min(1).max(600).optional()
});

const conversationListSchema = z.object({
  query: z.string().trim().max(120).optional(),
  limit: z.number().int().min(1).max(200).optional()
});

const conversationIdSchema = z.object({ id: z.string().min(1).max(100) });

const switchModelSchema = z.object({
  conversationId: z.string().min(1).max(100),
  sessionId: z.string().min(1).max(100),
  confirm: z.literal(true)
});

export interface WorkspaceHandlersOptions {
  registry: IpcRegistry;
  catalogue: CatalogueService;
  sessions: SessionOrchestrator;
  history: HistoryRepository;
  broadcastChat: (payload: ChatChunk) => void;
}

const TITLE_MAX_LENGTH = 60;

/**
 * Catalogue, session, conversation, and chat surface. Conversations survive the
 * session that produced them: a chat can be reopened later, and its model can be
 * swapped once the user confirms the switch.
 */
export function registerWorkspaceHandlers(options: WorkspaceHandlersOptions): void {
  const { registry, catalogue, sessions, history, broadcastChat } = options;

  registry.register("catalogue.search", catalogueQuerySchema, (query): Promise<CatalogueResult> => {
    return catalogue.search(query);
  });

  registry.register("catalogue.detail", modelIdSchema, (payload): Promise<ModelDetail> => {
    return catalogue.detail(payload.id);
  });

  registry.register("catalogue.refresh", z.unknown(), (): Promise<CatalogueResult> => {
    return catalogue.refresh();
  });

  registry.register("estimate.create", estimateRequestSchema, async (payload) => {
    return sessions.createEstimate(payload.modelId, payload.expectedMinutes ?? 30);
  });

  registry.register("session.list", z.unknown(), (): Session[] => sessions.listSessions());

  registry.register("session.status", z.unknown(), (): Session | null => sessions.getStatus());

  registry.register("session.start", sessionStartSchema, async (payload): Promise<Session> => {
    return sessions.start(payload);
  });

  registry.register("session.end", sessionEndSchema, async (payload): Promise<Session | null> => {
    return sessions.end(payload.sessionId, payload.reason ?? "user");
  });

  registry.register(
    "conversation.list",
    conversationListSchema,
    (payload): ConversationSummary[] => {
      const summaries = payload.query
        ? history.searchConversations(payload.query, payload.limit ?? 50)
        : history.listConversations(payload.limit ?? 100);

      const running = new Map(sessions.listSessions().map((session) => [session.modelId, session]));

      return summaries.map((summary) => ({
        id: summary.id,
        title: summary.title,
        modelId: summary.modelId,
        updatedAt: summary.updatedAt,
        messageCount: summary.messageCount,
        frozen: summary.modelId !== null && !running.has(summary.modelId)
      }));
    }
  );

  registry.register("conversation.get", conversationIdSchema, (payload): ConversationDetail => {
    const found = history.getConversation(payload.id);
    if (!found) {
      throw Object.assign(new Error("Conversation not found"), { code: "NOT_FOUND" });
    }

    const running = new Map(sessions.listSessions().map((session) => [session.modelId, session]));

    return {
      conversation: {
        id: found.conversation.id,
        title: found.conversation.title,
        modelId: found.conversation.modelId,
        sessionId: found.conversation.sessionId,
        updatedAt: found.conversation.updatedAt
      },
      messages: found.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt
      })),
      frozen:
        found.conversation.modelId !== null && !running.has(found.conversation.modelId)
    };
  });

  registry.register("conversation.switchModel", switchModelSchema, (payload): ConversationDetail => {
    const found = history.getConversation(payload.conversationId);
    if (!found) {
      throw Object.assign(new Error("Conversation not found"), { code: "NOT_FOUND" });
    }

    const session = sessions.getSession(payload.sessionId);
    if (!session) {
      throw Object.assign(new Error("That model is not running any more."), { code: "NOT_FOUND" });
    }

    const previousModelId = found.conversation.modelId;
    if (previousModelId === session.modelId) {
      return registryResult(history, sessions, payload.conversationId);
    }

    history.appendMessage({
      conversationId: payload.conversationId,
      role: "system",
      content:
        `Model switched from ${previousModelId ?? "unknown"} to ${session.modelId}. ` +
        "Earlier replies in this conversation came from the previous model."
    });
    history.updateConversationModel(payload.conversationId, session.modelId, session.id);

    return registryResult(history, sessions, payload.conversationId);
  });

  registry.register("chat.send", chatSendSchema, async (payload) => {
    const session = sessions.getSession(payload.sessionId);
    if (!session) {
      throw Object.assign(new Error("That model is not running any more."), { code: "NOT_FOUND" });
    }

    const conversationId =
      payload.conversationId ??
      history.createConversation({
        title: payload.content.slice(0, TITLE_MAX_LENGTH) || "New chat",
        modelId: session.modelId,
        origin: "app",
        sessionId: session.id
      }).id;

    const existing = history.getConversation(conversationId);
    if (!existing) {
      throw Object.assign(new Error("Conversation not found"), { code: "NOT_FOUND" });
    }

    history.appendMessage({
      conversationId,
      role: "user",
      content: payload.content
    });

    let text = "";
    const result = await sessions.send(session.id, payload.content, (kind, delta) => {
      if (kind === "content") {
        text += delta;
      }
      broadcastChat({
        sessionId: session.id,
        conversationId,
        kind,
        delta,
        done: false
      });
    });

    history.appendMessage({
      conversationId,
      role: "assistant",
      content: text,
      completionTokens: result.tokens
    });

    broadcastChat({
      sessionId: session.id,
      conversationId,
      kind: "content",
      delta: "",
      done: true,
      tokens: result.tokens
    });

    return { conversationId, tokens: result.tokens, text };
  });

  registry.register("chat.abort", chatAbortSchema, (payload) => {
    sessions.abort(payload.sessionId);
    return { aborted: true };
  });
}

function registryResult(
  history: HistoryRepository,
  sessions: SessionOrchestrator,
  conversationId: string
): ConversationDetail {
  const found = history.getConversation(conversationId);
  if (!found) {
    throw Object.assign(new Error("Conversation not found"), { code: "NOT_FOUND" });
  }

  const running = new Map(sessions.listSessions().map((session) => [session.modelId, session]));

  return {
    conversation: {
      id: found.conversation.id,
      title: found.conversation.title,
      modelId: found.conversation.modelId,
      sessionId: found.conversation.sessionId,
      updatedAt: found.conversation.updatedAt
    },
    messages: found.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt
    })),
    frozen: found.conversation.modelId !== null && !running.has(found.conversation.modelId)
  };
}
