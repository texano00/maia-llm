import { mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { HistoryRepository } from "../../src/main/services/history/repository";
import {
  ConversationImageStore,
  readImageDimensions
} from "../../src/main/services/history/images";

/** PNG header: signature + IHDR, which is all the size reader needs. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  return header;
}

/** SOI + APP0 + SOF0, enough for the segment walk to reach the frame size. */
function jpeg(width: number, height: number): Buffer {
  const buffer = Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00,
    0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01,
    0x03, 0x11, 0x01
  ]);

  buffer.writeUInt16BE(height, 25);
  buffer.writeUInt16BE(width, 27);
  return buffer;
}

/** Lossless WebP: 14-bit width/height packed after the 0x2f signature. */
function webp(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8L", 12, "ascii");
  buffer.writeUInt32LE(10, 16);
  buffer[20] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  buffer.writeUInt32LE(bits >>> 0, 21);
  return buffer;
}

describe("image size detection", () => {
  it("reads PNG, JPEG and WebP dimensions from the header", () => {
    expect(readImageDimensions(png(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
    expect(readImageDimensions(jpeg(800, 600), "image/jpeg")).toEqual({ width: 800, height: 600 });
    expect(readImageDimensions(webp(320, 200), "image/webp")).toEqual({ width: 320, height: 200 });
  });

  it("refuses bytes that do not match the declared format", () => {
    expect(() => readImageDimensions(jpeg(10, 10), "image/png")).toThrow(/not a PNG/);
    expect(() => readImageDimensions(png(10, 10), "image/jpeg")).toThrow(/not a JPEG/);
    expect(() => readImageDimensions(Buffer.alloc(40), "image/webp")).toThrow(/not a WebP/);
  });
});

describe("ConversationImageStore", () => {
  let db: DatabaseConnection;
  let history: HistoryRepository;
  let root: string;
  let store: ConversationImageStore;
  let conversationId: string;
  let messageId: string;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    history = new HistoryRepository(db);
    root = await mkdtemp(join(tmpdir(), "maia-images-"));
    store = new ConversationImageStore(db, root);

    conversationId = history.createConversation({
      title: "Look at this",
      modelId: "Qwen/Qwen2.5-VL-7B-Instruct",
      origin: "app"
    }).id;
    messageId = history.appendMessage({ conversationId, role: "user", content: "what is this?" }).id;
  });

  afterEach(async () => {
    closeDatabase(db);
    await rm(root, { recursive: true, force: true });
  });

  async function saveOne(buffer: Buffer, mimeType: "image/png" | "image/jpeg" | "image/webp") {
    return store.save({
      conversationId,
      messageId,
      direction: "input",
      mimeType,
      dataBase64: buffer.toString("base64")
    });
  }

  it("saves the bytes under the conversation folder and returns header dimensions", async () => {
    const image = await saveOne(png(1280, 720), "image/png");

    expect(image).toMatchObject({ mimeType: "image/png", width: 1280, height: 720 });

    const files = await readdir(join(root, conversationId));
    expect(files).toEqual([`${image.id}.png`]);
  });

  it("stores metadata only, and loads the bytes back on demand", async () => {
    const payload = png(64, 32);
    const image = await saveOne(payload, "image/png");

    expect(store.listForMessage(conversationId, messageId)).toEqual([image]);

    const loaded = await store.load(image.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.mimeType).toBe("image/png");
    expect(Buffer.from(loaded!.dataBase64, "base64").equals(payload)).toBe(true);
  });

  it("keeps several images of one turn in the order they arrived", async () => {
    const first = await saveOne(png(10, 10), "image/png");
    const second = await saveOne(jpeg(20, 20), "image/jpeg");
    const third = await saveOne(webp(30, 30), "image/webp");

    const list = store.listForMessage(conversationId, messageId);
    expect(list.map((image) => image.id)).toEqual([first.id, second.id, third.id]);

    const grouped = store.imagesByMessage(conversationId);
    expect(grouped.get(messageId)?.length).toBe(3);
  });

  it("rejects a file whose bytes are not the format the caller declared", async () => {
    await expect(saveOne(jpeg(10, 10), "image/png")).rejects.toThrow(/not a PNG/);
    expect(await readdir(join(root, conversationId)).catch(() => [])).toEqual([]);
  });

  it("rejects empty and malformed payloads", async () => {
    await expect(
      store.save({
        conversationId,
        messageId,
        direction: "input",
        mimeType: "image/png",
        dataBase64: ""
      })
    ).rejects.toThrow(/empty/);

    await expect(
      store.save({
        conversationId,
        messageId,
        direction: "input",
        mimeType: "image/png",
        dataBase64: "not an image!"
      })
    ).rejects.toThrow(/base64/);
  });

  it("refuses an image above 20 MB before decoding it", async () => {
    // 28 MB of base64 is ~21 MB of bytes: over the cap, and the check must fire
    // before the payload is materialised.
    await expect(
      store.save({
        conversationId,
        messageId,
        direction: "input",
        mimeType: "image/png",
        dataBase64: "A".repeat(28_000_000)
      })
    ).rejects.toThrow(/20 MB or smaller/);
  });

  it("accepts a data URL as well as bare base64", async () => {
    const image = await store.save({
      conversationId,
      messageId,
      direction: "input",
      mimeType: "image/png",
      dataBase64: `data:image/png;base64,${png(5, 5).toString("base64")}`
    });

    expect(image.width).toBe(5);
  });

  it("does not leave a file behind when the conversation no longer exists", async () => {
    await expect(
      store.save({
        conversationId: "no-such-conversation",
        messageId,
        direction: "input",
        mimeType: "image/png",
        dataBase64: png(10, 10).toString("base64")
      })
    ).rejects.toThrow();

    const orphans = await readdir(join(root, "no-such-conversation")).catch(() => null);
    expect(orphans).toBeNull();
  });

  it("returns null when the row or the file has gone", async () => {
    const image = await saveOne(png(10, 10), "image/png");

    expect(await store.load("missing-image")).toBeNull();

    await unlink(join(root, conversationId, `${image.id}.png`));
    expect(await store.load(image.id)).toBeNull();
  });

  it("deletes every image folder of a conversation and ignores unknown ids", async () => {
    await saveOne(png(10, 10), "image/png");
    await saveOne(jpeg(10, 10), "image/jpeg");

    await store.deleteForConversation(conversationId);
    expect(await readdir(join(root, conversationId)).catch(() => null)).toBeNull();

    // A second delete, and a delete of something that never existed, stay quiet.
    await store.deleteForConversation(conversationId);
    await store.deleteForConversation("never-created");
    await store.deleteForConversation("   ");
  });

  it("never follows a tampered path out of the image root", async () => {
    const image = await saveOne(png(10, 10), "image/png");

    // A row can be rewritten by anything that can open the database, so reads
    // must not trust `relative_path` to stay inside the store.
    db.prepare("UPDATE conversation_images SET relative_path = ? WHERE id = ?").run(
      join("..", "..", "etc", "passwd"),
      image.id
    );

    await expect(store.load(image.id)).rejects.toThrow(/escapes the image store/);
  });
});
