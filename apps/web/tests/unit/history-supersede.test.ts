import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { seedAccount } from "../helpers/accounts";
import { HistoryRepository } from "../../src/main/services/history/repository";

describe("superseded attempts", () => {
  let db: DatabaseConnection;
  let repository: HistoryRepository;
  let conversationId: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedAccount(db);
    repository = new HistoryRepository(db, "account-test");
    conversationId = repository.createConversation({ title: "Attempts", origin: "app" }).id;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("hides a regenerated reply from the transcript but keeps it in storage", () => {
    const question = repository.appendMessage({
      conversationId,
      role: "user",
      content: "Name a colour"
    });
    const first = repository.appendMessage({
      conversationId,
      role: "assistant",
      content: "Blue."
    });
    const second = repository.appendMessage({
      conversationId,
      role: "assistant",
      content: "Green."
    });

    repository.supersedeMessage(first.id, second.id);

    const visible = repository.getConversation(conversationId);
    expect(visible?.messages.map((message) => message.id)).toEqual([question.id, second.id]);

    const all = repository.getAllMessages(conversationId);
    expect(all.map((message) => message.id)).toEqual([question.id, first.id, second.id]);
    expect(all.find((message) => message.id === first.id)?.supersededBy).toBe(second.id);
  });

  it("hides an edited turn and everything after it", () => {
    const first = repository.appendMessage({ conversationId, role: "user", content: "First" });
    repository.appendMessage({ conversationId, role: "assistant", content: "Answer" });
    const edited = repository.appendMessage({ conversationId, role: "user", content: "Second" });

    repository.supersedeFrom(conversationId, first.sequence, edited.id, edited.sequence);

    const visible = repository.getConversation(conversationId);
    expect(visible?.messages.map((message) => message.id)).toEqual([edited.id]);
    expect(repository.getAllMessages(conversationId)).toHaveLength(3);
  });

  it("does not count superseded messages in list or search", () => {
    const question = repository.appendMessage({
      conversationId,
      role: "user",
      content: "unique-token-question"
    });
    const answer = repository.appendMessage({
      conversationId,
      role: "assistant",
      content: "unique-token-answer"
    });

    repository.supersedeMessage(answer.id, question.id);

    const listed = repository.listConversations();
    expect(listed.find((entry) => entry.id === conversationId)?.messageCount).toBe(1);
    expect(repository.searchConversations("unique-token-answer")).toHaveLength(0);
  });

  it("never supersedes a message from another account", () => {
    const other = new HistoryRepository(db, "account-other");
    const question = repository.appendMessage({ conversationId, role: "user", content: "Mine" });
    const answer = repository.appendMessage({ conversationId, role: "assistant", content: "Okay" });

    other.supersedeMessage(answer.id, question.id);

    expect(repository.getConversation(conversationId)?.messages).toHaveLength(2);
  });
});
