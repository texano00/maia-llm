import { z } from "zod";
import type {
  CatalogueResult,
  ConversationDetail,
  ConversationImageResult,
  ConversationSummary,
  ModelDetail,
  Session,
  UseCaseCard
} from "@maia/contracts";
import {
  catalogueQuerySchema,
  chatAbortSchema,
  chatSendSchema,
  conversationDeleteSchema,
  conversationImageRequestSchema,
  powerTierSchema,
  sessionEndSchema,
  sessionStartSchema,
  type ChatChunk
} from "@maia/contracts";
import type { IpcRegistry } from "./registry";
import type { CatalogueService } from "../services/catalogue/service";
import type { SessionOrchestrator } from "../services/sessions/orchestrator";
import type { HistoryRepository } from "../services/history/repository";
import type { ConversationImageStore } from "../services/history/images";

const modelIdSchema = z.object({ id: z.string().min(1).max(200) });

const estimateRequestSchema = z.object({
  modelId: z.string().min(1).max(200),
  expectedMinutes: z.number().int().min(1).max(600).optional(),
  powerTier: powerTierSchema.optional()
});

const estimatePreviewRequestSchema = z.object({
  modelId: z.string().min(1).max(200),
  powerTier: powerTierSchema,
  expectedMinutes: z.number().int().min(1).max(600).optional()
});

const conversationListSchema = z.object({
  query: z.string().trim().max(120).optional(),
  limit: z.number().int().min(1).max(200).optional()
});

const conversationIdSchema = z.object({ id: z.string().min(1).max(100) });

const sessionIdSchema = z.object({ sessionId: z.string().min(1).max(100) });

const switchModelSchema = z.object({
  conversationId: z.string().min(1).max(100),
  sessionId: z.string().min(1).max(100),
  confirm: z.literal(true)
});

const renameConversationSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(200)
});

const pinConversationSchema = z.object({
  id: z.string().min(1).max(100),
  pinned: z.boolean()
});

export interface WorkspaceHandlersOptions {
  registry: IpcRegistry;
  catalogue: CatalogueService;
  sessions: SessionOrchestrator;
  history: HistoryRepository;
  /** Image bytes for vision turns; transcripts only carry their metadata. */
  images: ConversationImageStore;
  broadcastChat: (payload: ChatChunk) => void;
  /** Basic-mode cards; absent when the app never talks to a portal. */
  useCases?: (() => Promise<UseCaseCard[]>) | undefined;
}

const TITLE_MAX_LENGTH = 60;

/**
 * Catalogue, session, conversation, and chat surface. Conversations survive the
 * session that produced them: a chat can be reopened later, and its model can be
 * swapped once the user confirms the switch.
 */
export function registerWorkspaceHandlers(options: WorkspaceHandlersOptions): void {
  const { registry, catalogue, sessions, history, broadcastChat, images } = options;

  registry.register("catalogue.search", catalogueQuerySchema, (query): Promise<CatalogueResult> => {
    return catalogue.search(query);
  });

  registry.register("catalogue.detail", modelIdSchema, (payload): Promise<ModelDetail> => {
    return catalogue.detail(payload.id);
  });

  registry.register("catalogue.refresh", z.unknown(), (): Promise<CatalogueResult> => {
    return catalogue.refresh();
  });

  registry.register("catalogue.useCases", z.unknown(), async (): Promise<UseCaseCard[]> => {
    return options.useCases ? options.useCases() : [];
  });

  registry.register("estimate.create", estimateRequestSchema, async (payload) => {
    return sessions.createEstimate(
      payload.modelId,
      payload.expectedMinutes ?? 30,
      payload.powerTier
    );
  });

  registry.register("estimate.preview", estimatePreviewRequestSchema, async (payload) => {
    return sessions.previewEstimate(
      payload.modelId,
      payload.powerTier,
      payload.expectedMinutes ?? 30
    );
  });

  registry.register("session.list", z.unknown(), (): Session[] => sessions.listSessions());

  // Ended runs that stay visible in the Models view; `session.list` above remains
  // the active-only query used by Chat and the catalogue.
  registry.register("session.history", z.unknown(), (): Session[] => sessions.listSessionHistory());

  registry.register("session.status", z.unknown(), (): Session | null => sessions.getStatus());

  // Only a serving run has an endpoint, and only while it lasts: the answer
  // carries the key the server was started with.
  registry.register("session.endpoint", sessionIdSchema, (payload) =>
    sessions.describeEndpoint(payload.sessionId)
  );

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
        pinned: summary.pinned,
        frozen: summary.modelId !== null && !running.has(summary.modelId)
      }));
    }
  );

  registry.register("conversation.rename", renameConversationSchema, (payload) => {
    history.renameConversation(payload.id, payload.title);
    return describeConversation(history, sessions, images, payload.id);
  });

  registry.register("conversation.setPinned", pinConversationSchema, (payload) => {
    history.setPinned(payload.id, payload.pinned);
    return describeConversation(history, sessions, images, payload.id);
  });

  registry.register("conversation.get", conversationIdSchema, (payload): ConversationDetail => {
    return describeConversation(history, sessions, images, payload.id);
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
      return describeConversation(history, sessions, images, payload.conversationId);
    }

    history.appendMessage({
      conversationId: payload.conversationId,
      role: "system",
      content:
        `Model switched from ${previousModelId ?? "unknown"} to ${session.modelId}. ` +
        "Earlier replies in this conversation came from the previous model."
    });
    history.updateConversationModel(payload.conversationId, session.modelId, session.id);

    return describeConversation(history, sessions, images, payload.conversationId);
  });

  registry.register("chat.send", chatSendSchema, async (payload) => {
    const session = sessions.getSession(payload.sessionId);
    if (!session) {
      throw Object.assign(new Error("That model is not running any more."), { code: "NOT_FOUND" });
    }

    // Checked before anything is written: a text model would either ignore the
    // images or fail mid-turn, leaving a user message that was never answered.
    if (payload.images.length > 0 && session.capability !== "image-to-text") {
      throw Object.assign(
        new Error("This model only reads text. Start a model that accepts images to send one."),
        { code: "CAPABILITY_UNSUPPORTED" }
      );
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

    const userMessage = history.appendMessage({
      conversationId,
      role: "user",
      content: payload.content
    });

    // Saved before inference so the turn survives a failed or aborted reply.
    for (const image of payload.images) {
      await images.save({
        conversationId,
        messageId: userMessage.id,
        direction: "input",
        mimeType: image.mimeType,
        dataBase64: image.dataBase64
      });
    }

    let text = "";
    // Reasoning models stream their thinking first; it is stored next to the
    // answer so the chat can show it on demand once the turn has finished.
    let reasoning = "";
    const result = await sessions.send(
      session.id,
      payload.content,
      (kind, delta) => {
        if (kind === "content") {
          text += delta;
        } else {
          reasoning += delta;
        }
        broadcastChat({
          sessionId: session.id,
          conversationId,
          kind,
          delta,
          done: false
        });
      },
      payload.images
    );

    history.appendMessage({
      conversationId,
      role: "assistant",
      content: text,
      reasoning: reasoning.length > 0 ? reasoning : null,
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

  // Deleting is permanent, so any reply in flight is stopped first: a late chunk
  // must never recreate rows for a conversation the user just removed.
  registry.register("conversation.delete", conversationDeleteSchema, async (payload) => {
    const found = history.getConversation(payload.id);
    if (!found) {
      throw Object.assign(new Error("Conversation not found"), { code: "NOT_FOUND" });
    }

    if (found.conversation.sessionId) {
      sessions.abort(found.conversation.sessionId);
    }

    history.deleteConversation(payload.id);
    // The rows cascade, but the bytes are files: without this the image folder
    // would outlive the conversation forever.
    await images.deleteForConversation(payload.id);
    return { deleted: true as const, id: payload.id };
  });

  registry.register(
    "conversation.image",
    conversationImageRequestSchema,
    async (payload): Promise<ConversationImageResult> => {
      const image = await images.load(payload.id);
      if (!image) {
        throw Object.assign(new Error("That image is no longer available."), {
          code: "NOT_FOUND"
        });
      }

      return image;
    }
  );
}

function describeConversation(
  history: HistoryRepository,
  sessions: SessionOrchestrator,
  images: ConversationImageStore,
  conversationId: string
): ConversationDetail {
  const found = history.getConversation(conversationId);
  if (!found) {
    throw Object.assign(new Error("Conversation not found"), { code: "NOT_FOUND" });
  }

  const running = new Map(sessions.listSessions().map((session) => [session.modelId, session]));
  const grouped = images.imagesByMessage(conversationId);

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
      reasoning: message.reasoning,
      images: grouped.get(message.id) ?? [],
      createdAt: message.createdAt
    })),
    frozen:
      found.conversation.modelId !== null && !running.has(found.conversation.modelId)
  };
}
