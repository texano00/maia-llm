import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { HistoryRepository } from "../../src/main/services/history/repository";
import { ConversationImageStore } from "../../src/main/services/history/images";
import { IpcRegistry } from "../../src/main/ipc/registry";
import { registerWorkspaceHandlers } from "../../src/main/ipc/workspace";
import type { CatalogueService } from "../../src/main/services/catalogue/service";
import type { SessionOrchestrator } from "../../src/main/services/sessions/orchestrator";

interface Harness {
  registry: IpcRegistry;
  history: HistoryRepository;
  images: ConversationImageStore;
  aborted: string[];
}

function harness(db: DatabaseConnection, imagesDir: string): Harness {
  const registry = new IpcRegistry();
  const history = new HistoryRepository(db);
  const images = new ConversationImageStore(db, imagesDir);
  const aborted: string[] = [];
  const sessions = {
    listSessions: () => [],
    abort: (sessionId: string) => {
      aborted.push(sessionId);
    }
  } as unknown as SessionOrchestrator;

  registerWorkspaceHandlers({
    registry,
    catalogue: {} as CatalogueService,
    sessions,
    history,
    images,
    broadcastChat: () => undefined
  });

  return { registry, history, images, aborted };
}

describe("conversation.delete", () => {
  let db: DatabaseConnection;
  let rig: Harness;
  let imagesDir: string;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    imagesDir = await mkdtemp(join(tmpdir(), "maia-chat-images-"));
    rig = harness(db, imagesDir);
  });

  afterEach(async () => {
    closeDatabase(db);
    await rm(imagesDir, { recursive: true, force: true });
  });

  function seed(title: string, sessionId: string | null = null) {
    return rig.history.createConversation({ title, modelId: "Qwen/Qwen2.5-7B-Instruct", origin: "app", sessionId });
  }

  it("removes only the selected conversation", async () => {
    const keep = seed("Keep me");
    const drop = seed("Delete me");
    rig.history.appendMessage({ conversationId: drop.id, role: "user", content: "hello" });

    const result = await rig.registry.invoke("conversation.delete", { id: drop.id });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data).toEqual({ deleted: true, id: drop.id });
    expect(rig.history.getConversation(drop.id)).toBeNull();
    expect(rig.history.getConversation(keep.id)).not.toBeNull();
  });

  it("stops an in-flight reply before removing the conversation", async () => {
    const conversation = seed("Streaming chat", "session-42");

    await rig.registry.invoke("conversation.delete", { id: conversation.id });

    expect(rig.aborted).toEqual(["session-42"]);
    expect(rig.history.getConversation(conversation.id)).toBeNull();
  });

  it("reports an unknown conversation as NOT_FOUND", async () => {
    const result = await rig.registry.invoke("conversation.delete", { id: "missing" });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("NOT_FOUND");
  });
});
