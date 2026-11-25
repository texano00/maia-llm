import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@maia/contracts";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { seedAccount } from "../helpers/accounts";
import { HistoryRepository } from "../../src/main/services/history/repository";
import { ConversationImageStore } from "../../src/main/services/history/images";
import { IpcRegistry } from "../../src/main/ipc/registry";
import { registerWorkspaceHandlers } from "../../src/main/ipc/workspace";
import type { CatalogueService } from "../../src/main/services/catalogue/service";
import type {
  InferenceMessage,
  SessionOrchestrator
} from "../../src/main/services/sessions/orchestrator";

interface Harness {
  registry: IpcRegistry;
  history: HistoryRepository;
  /** Every message array the model was asked to answer, in order. */
  seen: InferenceMessage[][];
}

function harness(db: DatabaseConnection, imagesDir: string, contextWindow: number): Harness {
  const registry = new IpcRegistry();
  const history = new HistoryRepository(db, "account-test");
  const images = new ConversationImageStore(db, imagesDir, "account-test");
  const seen: InferenceMessage[][] = [];

  const session: Session = {
    id: "session-1",
    modelId: "Qwen/Qwen2.5-7B-Instruct",
    state: "active",
    runtime: "vllm",
    label: "maia-chat",
    gpuName: "RTX 4090",
    gpuRamGb: 24,
    hourlyRateMicroUsd: 440_000,
    estimatedTotalMicroUsd: 220_000,
    startedAt: "2026-11-25T10:00:00.000Z",
    readyAt: "2026-11-25T10:02:00.000Z",
    endedAt: null,
    endReason: null,
    instanceId: 42,
    powerTier: "balanced",
    capability: "text",
    simulated: false,
    events: [],
    boot: null,
    endpoint: null,
    release: null,
    runtimeConfig: null,
    restart: null
  } as Session;

  const sessions = {
    getSession: (id: string) => (id === session.id ? session : null),
    listSessions: () => [session],
    runtimeConfig: () => ({
      current: { contextWindow, maxConcurrentRequests: 1 },
      defaults: { contextWindow: 32_768, maxConcurrentRequests: 1 },
      contextWindowMax: 131_072,
      contextWindowMaxSource: "model",
      concurrencyMax: 1,
      estimatedMaxContext: 131_072,
      fits: true,
      restart: null
    }),
    send: async (
      _id: string,
      messages: InferenceMessage[],
      onDelta: (kind: string, text: string) => void
    ) => {
      seen.push(messages);
      onDelta("content", "ok");
      return { tokens: 1, text: "ok" };
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

  return { registry, history, seen };
}

describe("chat turns use the stored conversation", () => {
  let db: DatabaseConnection;
  let imagesDir: string;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    seedAccount(db);
    imagesDir = await mkdtemp(join(tmpdir(), "maia-chat-turn-"));
  });

  afterEach(async () => {
    closeDatabase(db);
    await rm(imagesDir, { recursive: true, force: true });
  });

  it("sends earlier turns, oldest first, on the next message", async () => {
    const rig = harness(db, imagesDir, 32_768);

    const first = await rig.registry.invoke("chat.send", {
      sessionId: "session-1",
      content: "first question"
    });
    const conversationId = first.ok
      ? (first.data as { conversationId: string }).conversationId
      : "";

    await rig.registry.invoke("chat.send", {
      sessionId: "session-1",
      conversationId,
      content: "second question"
    });

    expect(rig.seen[0]?.map((message) => message.content)).toEqual(["first question"]);
    expect(rig.seen[1]?.map((message) => message.content)).toEqual([
      "first question",
      "ok",
      "second question"
    ]);
  });

  it("discloses how many turns did not fit a small window", async () => {
    const rig = harness(db, imagesDir, 4096);

    const first = await rig.registry.invoke("chat.send", {
      sessionId: "session-1",
      content: "a".repeat(20_000)
    });
    const conversationId = first.ok
      ? (first.data as { conversationId: string }).conversationId
      : "";

    const second = await rig.registry.invoke("chat.send", {
      sessionId: "session-1",
      conversationId,
      content: "short follow-up"
    });

    expect(second.ok).toBe(true);
    if (second.ok) {
      expect((second.data as { omittedMessages: number }).omittedMessages).toBeGreaterThan(0);
    }
  });

  it("regenerates in place and retains the superseded reply", async () => {
    const rig = harness(db, imagesDir, 32_768);
    const first = await rig.registry.invoke("chat.send", {
      sessionId: "session-1",
      content: "question"
    });
    const conversationId = first.ok
      ? (first.data as { conversationId: string }).conversationId
      : "";

    const detail = rig.history.getConversation(conversationId);
    const reply = detail?.messages.find((message) => message.role === "assistant");
    expect(reply).toBeDefined();

    const regenerated = await rig.registry.invoke("chat.regenerate", {
      sessionId: "session-1",
      conversationId,
      assistantMessageId: reply?.id
    });

    expect(regenerated.ok).toBe(true);
    const visible = rig.history.getConversation(conversationId);
    expect(visible?.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(rig.history.getAllMessages(conversationId)).toHaveLength(3);
  });

  it("edits a message and supersedes the old attempt and its answer", async () => {
    const rig = harness(db, imagesDir, 32_768);
    const first = await rig.registry.invoke("chat.send", {
      sessionId: "session-1",
      content: "original question"
    });
    const conversationId = first.ok
      ? (first.data as { conversationId: string }).conversationId
      : "";

    const detail = rig.history.getConversation(conversationId);
    const question = detail?.messages.find((message) => message.role === "user");
    expect(question).toBeDefined();

    const edited = await rig.registry.invoke("chat.edit", {
      sessionId: "session-1",
      conversationId,
      userMessageId: question?.id,
      content: "edited question"
    });

    expect(edited.ok).toBe(true);
    const visible = rig.history.getConversation(conversationId);
    expect(visible?.messages.map((message) => message.content)).toContain("edited question");
    expect(visible?.messages.map((message) => message.content)).not.toContain("original question");
    expect(rig.history.getAllMessages(conversationId).length).toBeGreaterThan(visible?.messages.length ?? 0);
  });
});
