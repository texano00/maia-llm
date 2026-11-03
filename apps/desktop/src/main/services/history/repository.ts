import { randomUUID } from "node:crypto";
import type { ConversationOrigin, MessageRole } from "@maia/contracts";
import type { DatabaseConnection } from "../../storage/db";

interface ConversationRow {
  id: string;
  title: string;
  model_id: string | null;
  origin: ConversationOrigin;
  client_label: string | null;
  session_id: string | null;
  settings_json: string;
  created_at: string;
  updated_at: string;
  archived: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sequence: number;
  role: MessageRole;
  content: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  interrupted: number;
  error_code: string | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  title: string;
  modelId: string | null;
  origin: ConversationOrigin;
  clientLabel: string | null;
  sessionId: string | null;
  settings: unknown;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  sequence: number;
  role: MessageRole;
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
  interrupted: boolean;
  errorCode: string | null;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  modelId: string | null;
  origin: ConversationOrigin;
  updatedAt: string;
  messageCount: number;
  pinned: boolean;
  snippet?: string;
}

export interface CreateConversationInput {
  title: string;
  modelId?: string | null;
  origin: ConversationOrigin;
  clientLabel?: string | null;
  sessionId?: string | null;
  settings?: unknown;
}

export interface AppendMessageInput {
  conversationId: string;
  role: MessageRole;
  content: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  interrupted?: boolean;
  errorCode?: string | null;
}

export class HistoryRepository {
  constructor(private readonly db: DatabaseConnection) {}

  createConversation(input: CreateConversationInput): Conversation {
    const title = input.title.trim();
    if (title.length < 1 || title.length > 200) {
      throw new Error("Conversation title must be between 1 and 200 characters");
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const settings = JSON.stringify(input.settings ?? {});

    this.db
      .prepare(
        `INSERT INTO conversations
          (id, title, model_id, origin, client_label, session_id, settings_json, created_at, updated_at, archived)
         VALUES
          (@id, @title, @modelId, @origin, @clientLabel, @sessionId, @settings, @now, @now, 0)`
      )
      .run({
        id,
        title,
        modelId: input.modelId ?? null,
        origin: input.origin,
        clientLabel: input.clientLabel ?? null,
        sessionId: input.sessionId ?? null,
        settings,
        now
      });

    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
      | ConversationRow
      | undefined;

    if (!row) {
      throw new Error("Conversation insert failed");
    }

    return mapConversation(row);
  }

  appendMessage(input: AppendMessageInput): Message {
    const interrupted = input.interrupted ?? false;

    if (input.content.length === 0 && !(input.role === "assistant" && interrupted)) {
      throw new Error("Message content must be non-empty unless it is an interrupted assistant turn");
    }

    const insert = this.db.transaction(() => {
      const maxSequence = this.db
        .prepare("SELECT COALESCE(MAX(sequence), -1) AS max FROM messages WHERE conversation_id = ?")
        .get(input.conversationId) as { max: number };

      const id = randomUUID();
      const now = new Date().toISOString();
      const sequence = maxSequence.max + 1;

      this.db
        .prepare(
          `INSERT INTO messages
            (id, conversation_id, sequence, role, content, prompt_tokens, completion_tokens, interrupted, error_code, created_at)
           VALUES
            (@id, @conversationId, @sequence, @role, @content, @promptTokens, @completionTokens, @interrupted, @errorCode, @now)`
        )
        .run({
          id,
          conversationId: input.conversationId,
          sequence,
          role: input.role,
          content: input.content,
          promptTokens: input.promptTokens ?? null,
          completionTokens: input.completionTokens ?? null,
          interrupted: interrupted ? 1 : 0,
          errorCode: input.errorCode ?? null,
          now
        });

      this.db
        .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(now, input.conversationId);

      return { id, now, sequence };
    });

    const { id, now, sequence } = insert();

    return {
      id,
      conversationId: input.conversationId,
      sequence,
      role: input.role,
      content: input.content,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      interrupted,
      errorCode: input.errorCode ?? null,
      createdAt: now
    };
  }

  getConversation(id: string): { conversation: Conversation; messages: Message[] } | null {
    const conversation = this.db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as ConversationRow | undefined;

    if (!conversation) {
      return null;
    }

    const messages = this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY sequence ASC")
      .all(id) as MessageRow[];

    return {
      conversation: mapConversation(conversation),
      messages: messages.map(mapMessage)
    };
  }

  listConversations(limit = 50, offset = 0): ConversationSummary[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const safeOffset = Math.max(Math.trunc(offset), 0);

    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.model_id, c.origin, c.updated_at, c.pinned,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c
         ORDER BY c.pinned DESC, c.updated_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(safeLimit, safeOffset) as Array<{
      id: string;
      title: string;
      model_id: string | null;
      origin: ConversationOrigin;
      updated_at: string;
      pinned: number;
      message_count: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      modelId: row.model_id,
      origin: row.origin,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
      pinned: row.pinned === 1
    }));
  }

  searchConversations(query: string, limit = 50): ConversationSummary[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return [];
    }

    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const match = `"${trimmed.replace(/"/g, '""')}"`;

    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.model_id, c.origin, c.updated_at, c.pinned,
                MIN(m.sequence) AS first_sequence,
                (SELECT COUNT(*) FROM messages m2 WHERE m2.conversation_id = c.id) AS message_count
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN conversations c ON c.id = m.conversation_id
         WHERE messages_fts MATCH ?
         GROUP BY c.id
         ORDER BY c.pinned DESC, c.updated_at DESC
         LIMIT ?`
      )
      .all(match, safeLimit) as Array<{
      id: string;
      title: string;
      model_id: string | null;
      origin: ConversationOrigin;
      updated_at: string;
      pinned: number;
      first_sequence: number;
      message_count: number;
    }>;

    const snippetStatement = this.db.prepare(
      `SELECT snippet(messages_fts, 1, '[', ']', '…', 12) AS snippet
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE messages_fts MATCH ? AND m.conversation_id = ? AND m.sequence = ?
       LIMIT 1`
    );

    return rows.map((row) => {
      const snippetRow = snippetStatement.get(match, row.id, row.first_sequence) as
        | { snippet: string }
        | undefined;

      return {
        id: row.id,
        title: row.title,
        modelId: row.model_id,
        origin: row.origin,
        updatedAt: row.updated_at,
        messageCount: row.message_count,
        pinned: row.pinned === 1,
        ...(snippetRow ? { snippet: snippetRow.snippet } : {})
      };
    });
  }

  /** Pins or unpins a conversation so it sorts above the rest. */
  setPinned(id: string, pinned: boolean): void {
    const result = this.db
      .prepare("UPDATE conversations SET pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, id);

    if (result.changes === 0) {
      throw new Error("Conversation not found");
    }
  }

  /** Re-binds a conversation to another model after an explicit switch. */
  updateConversationModel(id: string, modelId: string, sessionId: string | null): void {
    this.db
      .prepare("UPDATE conversations SET model_id = ?, session_id = ?, updated_at = ? WHERE id = ?")
      .run(modelId, sessionId, new Date().toISOString(), id);
  }

  renameConversation(id: string, title: string): void {
    const trimmed = title.trim();
    if (trimmed.length < 1 || trimmed.length > 200) {
      throw new Error("Conversation title must be between 1 and 200 characters");
    }

    const result = this.db
      .prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
      .run(trimmed, new Date().toISOString(), id);

    if (result.changes === 0) {
      throw new Error("Conversation not found");
    }
  }

  deleteConversation(id: string): void {
    const result = this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);

    if (result.changes === 0) {
      throw new Error("Conversation not found");
    }
  }
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    modelId: row.model_id,
    origin: row.origin,
    clientLabel: row.client_label,
    sessionId: row.session_id,
    settings: safeParseJson(row.settings_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: row.sequence,
    role: row.role,
    content: row.content,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    interrupted: row.interrupted === 1,
    errorCode: row.error_code,
    createdAt: row.created_at
  };
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}
