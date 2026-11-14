import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationDetail, Session } from "@maia/contracts";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { seedAccount } from "../helpers/accounts";
import { HistoryRepository } from "../../src/main/services/history/repository";
import { ConversationImageStore } from "../../src/main/services/history/images";
import { IpcRegistry } from "../../src/main/ipc/registry";
import { registerWorkspaceHandlers } from "../../src/main/ipc/workspace";
import type { CatalogueService } from "../../src/main/services/catalogue/service";
import type { InferenceImage, SessionOrchestrator } from "../../src/main/services/sessions/orchestrator";

/** 1x1 PNG header (signature + IHDR), which is what the store reads. */
function pngBase64(): string {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(1024, 16);
  header.writeUInt32BE(768, 20);
  return header.toString("base64");
}

interface Harness {
  registry: IpcRegistry;
  history: HistoryRepository;
  /** What the orchestrator was asked to send, in order. */
  sent: InferenceImage[][];
}

function harness(
  db: DatabaseConnection,
  imagesDir: string,
  capability: Session["capability"]
): Harness {
  const registry = new IpcRegistry();
  const history = new HistoryRepository(db, "account-test");
  const images = new ConversationImageStore(db, imagesDir, "account-test");
  const sent: InferenceImage[][] = [];

  const session: Session = {
    id: "session-1",
    modelId: "Qwen/Qwen2.5-VL-7B-Instruct",
    state: "active",
    runtime: "vllm",
    label: "maia-vision",
    gpuName: "RTX 4090",
    gpuRamGb: 24,
    hourlyRateMicroUsd: 440_000,
    estimatedTotalMicroUsd: 220_000,
    startedAt: "2026-11-11T10:00:00.000Z",
    readyAt: "2026-11-11T10:02:00.000Z",
    endedAt: null,
    endReason: null,
    instanceId: 42,
    powerTier: "balanced",
    capability,
    simulated: false,
    events: []
  };

  const sessions = {
    getSession: (id: string) => (id === session.id ? session : null),
    listSessions: () => [session],
    send: async (
      _id: string,
      _content: string,
      onDelta: (kind: string, text: string) => void,
      attached: InferenceImage[] = []
    ) => {
      sent.push(attached);
      onDelta("content", "It is a red square.");
      return { tokens: 7, text: "It is a red square." };
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

  return { registry, history, sent };
}

describe("chat.send with images", () => {
  let db: DatabaseConnection;
  let imagesDir: string;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    seedAccount(db);
    imagesDir = await mkdtemp(join(tmpdir(), "maia-chat-attach-"));
  });

  afterEach(async () => {
    closeDatabase(db);
    await rm(imagesDir, { recursive: true, force: true });
  });

  it("refuses images on a text-only run and stores nothing", async () => {
    const rig = harness(db, imagesDir, "text");

    const result = await rig.registry.invoke("chat.send", {
      sessionId: "session-1",
      content: "what is this?",
      images: [{ mimeType: "image/png", dataBase64: pngBase64() }]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CAPABILITY_UNSUPPORTED");
    }

    // Nothing was written and the model was never called.
    expect(rig.history.listConversations(10)).toEqual([]);
    expect(rig.sent).toEqual([]);
  });

  it("saves the image, forwards it to the model, and keeps it in the transcript", async () => {
    const rig = harness(db, imagesDir, "image-to-text");

    const result = await rig.registry.invoke("chat.send", {
      sessionId: "session-1",
      content: "what is this?",
      images: [{ mimeType: "image/png", dataBase64: pngBase64() }]
    });

    expect(result.ok).toBe(true);
    const payload = result.ok ? (result.data as { conversationId: string }) : null;
    expect(payload).not.toBeNull();

    // The model received exactly one image.
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0]).toHaveLength(1);
    expect(rig.sent[0]?.[0]?.mimeType).toBe("image/png");

    const detail = await rig.registry.invoke("conversation.get", { id: payload!.conversationId });
    expect(detail.ok).toBe(true);

    const conversation = detail.ok ? (detail.data as ConversationDetail) : null;
    const userMessage = conversation?.messages.find((message) => message.role === "user");
    expect(userMessage?.images).toHaveLength(1);
    expect(userMessage?.images[0]).toMatchObject({ mimeType: "image/png", width: 1024, height: 768 });

    // The transcript carries metadata only; the bytes are fetched separately.
    const loaded = await rig.registry.invoke("conversation.image", {
      id: userMessage!.images[0]!.id
    });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const data = loaded.data as { mimeType: string; dataBase64: string };
      expect(data.mimeType).toBe("image/png");
      expect(Buffer.from(data.dataBase64, "base64").subarray(0, 4).toString("hex")).toBe("89504e47");
    }
  });

  it("still answers a text question on a vision run", async () => {
    const rig = harness(db, imagesDir, "image-to-text");

    const result = await rig.registry.invoke("chat.send", {
      sessionId: "session-1",
      content: "hello"
    });

    expect(result.ok).toBe(true);
    expect(rig.sent[0]).toEqual([]);
  });

  it("reports a missing image as NOT_FOUND", async () => {
    const rig = harness(db, imagesDir, "image-to-text");

    const result = await rig.registry.invoke("conversation.image", { id: "gone" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("rejects more than four images in one turn", async () => {
    const rig = harness(db, imagesDir, "image-to-text");
    const images = Array.from({ length: 5 }, () => ({
      mimeType: "image/png",
      dataBase64: pngBase64()
    }));

    const result = await rig.registry.invoke("chat.send", {
      sessionId: "session-1",
      content: "describe these",
      images
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
    }
  });
});
