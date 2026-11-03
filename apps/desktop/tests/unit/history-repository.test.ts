import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { HistoryRepository } from "../../src/main/services/history/repository";

describe("HistoryRepository", () => {
  let db: DatabaseConnection;
  let repository: HistoryRepository;

  beforeEach(() => {
    db = openDatabase(":memory:");
    repository = new HistoryRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("creates a conversation and appends messages in sequence order", () => {
    const conversation = repository.createConversation({
      title: "Refactor notes",
      origin: "app",
      settings: { temperature: 0.2 }
    });

    const first = repository.appendMessage({
      conversationId: conversation.id,
      role: "user",
      content: "Explain the stack trace"
    });
    const second = repository.appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: "The failure starts in the parser."
    });

    expect(first.sequence).toBe(0);
    expect(second.sequence).toBe(1);

    const loaded = repository.getConversation(conversation.id);
    expect(loaded?.messages.map((message) => message.content)).toEqual([
      "Explain the stack trace",
      "The failure starts in the parser."
    ]);
  });

  it("finds conversations through full-text search", () => {
    const conversation = repository.createConversation({
      title: "GPU notes",
      origin: "app"
    });
    repository.appendMessage({
      conversationId: conversation.id,
      role: "user",
      content: "How do I verify the backup checksum?"
    });

    const results = repository.searchConversations("backup checksum");
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(conversation.id);
    expect(results[0]?.snippet).toContain("backup");
  });

  it("rejects empty content unless it is an interrupted assistant turn", () => {
    const conversation = repository.createConversation({ title: "Empty", origin: "app" });

    expect(() =>
      repository.appendMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: ""
      })
    ).toThrow(/non-empty/);

    expect(() =>
      repository.appendMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: "",
        interrupted: true
      })
    ).not.toThrow();
  });

  it("validates conversation titles", () => {
    expect(() => repository.createConversation({ title: " ", origin: "app" })).toThrow(
      /between 1 and 200/
    );
    expect(() =>
      repository.createConversation({ title: "x".repeat(201), origin: "app" })
    ).toThrow(/between 1 and 200/);
  });

  it("deletes conversations and their messages", () => {
    const conversation = repository.createConversation({ title: "Delete me", origin: "app" });
    repository.appendMessage({
      conversationId: conversation.id,
      role: "user",
      content: "temporary"
    });

    repository.deleteConversation(conversation.id);

    expect(repository.getConversation(conversation.id)).toBeNull();
    expect(repository.searchConversations("temporary")).toHaveLength(0);
  });

  it("keeps pinned conversations at the top of the list", () => {
    const older = repository.createConversation({ title: "Older chat", origin: "app" });
    const newer = repository.createConversation({ title: "Newer chat", origin: "app" });

    // Both rows can share the same millisecond timestamp, so only pin order is asserted.
    expect(repository.listConversations().map((entry) => entry.id).sort()).toEqual(
      [newer.id, older.id].sort()
    );

    repository.setPinned(older.id, true);

    const pinnedFirst = repository.listConversations();
    expect(pinnedFirst[0]?.id).toBe(older.id);
    expect(pinnedFirst[0]?.pinned).toBe(true);
    expect(pinnedFirst[1]?.pinned).toBe(false);

    repository.setPinned(older.id, false);
    expect(repository.listConversations().every((entry) => !entry.pinned)).toBe(true);
  });

  it("renames a conversation and rejects empty titles", () => {
    const conversation = repository.createConversation({ title: "Draft", origin: "app" });

    repository.renameConversation(conversation.id, "  Refactor notes  ");

    expect(repository.listConversations()[0]).toMatchObject({ title: "Refactor notes" });
    expect(() => repository.renameConversation(conversation.id, "   ")).toThrow(/between 1 and 200/);
    expect(() => repository.renameConversation("missing", "Nope")).toThrow(/not found/);
  });
});
