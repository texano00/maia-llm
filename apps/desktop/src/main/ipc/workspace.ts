import { z } from "zod";
import type {
  CatalogueResult,
  ModelDetail,
  Session
} from "@maia/contracts";
import {
  catalogueQuerySchema,
  chatAbortSchema,
  chatSendSchema,
  sessionEndSchema,
  sessionStartSchema
} from "@maia/contracts";
import type { IpcRegistry } from "./registry";
import type { CatalogueService } from "../services/catalogue/service";
import type { SessionOrchestrator } from "../services/sessions/orchestrator";

const modelIdSchema = z.object({ id: z.string().min(1).max(200) });

const estimateRequestSchema = z.object({
  modelId: z.string().min(1).max(200),
  expectedMinutes: z.number().int().min(1).max(600).optional()
});

export interface WorkspaceHandlersOptions {
  registry: IpcRegistry;
  catalogue: CatalogueService;
  sessions: SessionOrchestrator;
  broadcastChat: (payload: { sessionId: string; delta: string; done: boolean; tokens?: number; errorMessage?: string }) => void;
}

/** Catalogue, session, and chat surface for the MVP flow. */
export function registerWorkspaceHandlers(options: WorkspaceHandlersOptions): void {
  const { registry, catalogue, sessions, broadcastChat } = options;

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

  registry.register("session.status", z.unknown(), (): Session | null => sessions.getStatus());

  registry.register("session.start", sessionStartSchema, async (payload): Promise<Session> => {
    return sessions.start(payload);
  });

  registry.register("session.end", sessionEndSchema, async (payload): Promise<Session | null> => {
    return sessions.end(payload.sessionId, payload.reason ?? "user");
  });

  registry.register("chat.send", chatSendSchema, async (payload) => {
    let streamed = "";
    const result = await sessions.send(payload.sessionId, payload.content, (delta) => {
      streamed += delta;
      broadcastChat({ sessionId: payload.sessionId, delta, done: false });
    });

    broadcastChat({
      sessionId: payload.sessionId,
      delta: "",
      done: true,
      tokens: result.tokens
    });

    return { tokens: result.tokens, text: streamed };
  });

  registry.register("chat.abort", chatAbortSchema, (payload) => {
    sessions.abort(payload.sessionId);
    return { aborted: true };
  });
}
