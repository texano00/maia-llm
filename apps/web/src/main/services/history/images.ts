import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  MAX_IMAGE_BYTES,
  imageMimeTypeSchema,
  type ChatImage,
  type ChatImageInput
} from "@maia/contracts";
import type { DatabaseConnection } from "../../storage/db";

type ImageMimeType = ChatImage["mimeType"];

interface ImageRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  direction: "input" | "output";
  mime_type: ImageMimeType;
  width: number;
  height: number;
  relative_path: string;
  created_at: string;
}

export interface SaveImageInput extends ChatImageInput {
  conversationId: string;
  messageId: string;
  direction: "input" | "output";
}

const EXTENSIONS: Record<ImageMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

const MAX_MEGABYTES = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "VALIDATION_FAILED" });
}

/**
 * Image attachments for vision runs. Bytes live under `images/<account>/<chat>/`
 * and only metadata is stored in SQLite, so a transcript query never has to load
 * megabytes it is not showing. Every row and path is bound to one account.
 */
export class ConversationImageStore {
  private readonly rootDir: string;

  constructor(
    private readonly db: DatabaseConnection,
    baseDir: string,
    private readonly accountId: string
  ) {
    this.rootDir = join(baseDir, accountId);
  }

  async save(input: SaveImageInput): Promise<ChatImage> {
    const buffer = decodeImage(input.dataBase64);

    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw invalid(`Images must be ${MAX_MEGABYTES} MB or smaller.`);
    }

    const { width, height } = readImageDimensions(buffer, input.mimeType);

    const id = randomUUID();
    const relativePath = join(input.conversationId, `${id}.${EXTENSIONS[input.mimeType]}`);
    const absolutePath = this.absolutePath(relativePath);

    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, buffer);

    try {
      this.db
        .prepare(
          `INSERT INTO conversation_images
            (id, account_id, conversation_id, message_id, direction, mime_type, width, height, relative_path, created_at)
           VALUES
            (@id, @accountId, @conversationId, @messageId, @direction, @mimeType, @width, @height, @relativePath, @now)`
        )
        .run({
          id,
          accountId: this.accountId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          direction: input.direction,
          mimeType: input.mimeType,
          width,
          height,
          relativePath,
          now: new Date().toISOString()
        });
    } catch (error) {
      // The row is the only thing that can find this file again, so a rejected
      // insert must not leave bytes (or an empty folder) orphaned on disk.
      await rm(absolutePath, { force: true });
      await rmdir(dirname(absolutePath)).catch(() => undefined);
      throw error;
    }

    return { id, mimeType: input.mimeType, width, height };
  }

  /** Metadata for one turn, oldest first. */
  listForMessage(conversationId: string, messageId: string): ChatImage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_images
         WHERE account_id = ? AND conversation_id = ? AND message_id = ?
         ORDER BY created_at ASC`
      )
      .all(this.accountId, conversationId, messageId) as ImageRow[];

    return rows.map(toChatImage);
  }

  /** Every image of a conversation, grouped by the message that carries it. */
  imagesByMessage(conversationId: string): Map<string, ChatImage[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_images
         WHERE account_id = ? AND conversation_id = ?
         ORDER BY created_at ASC`
      )
      .all(this.accountId, conversationId) as ImageRow[];

    const grouped = new Map<string, ChatImage[]>();
    for (const row of rows) {
      if (!row.message_id) {
        continue;
      }

      const existing = grouped.get(row.message_id) ?? [];
      existing.push(toChatImage(row));
      grouped.set(row.message_id, existing);
    }

    return grouped;
  }

  /** Reads one image back as base64 so the renderer can show it. */
  async load(id: string): Promise<{ id: string; mimeType: ImageMimeType; dataBase64: string } | null> {
    const row = this.db
      .prepare("SELECT * FROM conversation_images WHERE id = ? AND account_id = ?")
      .get(id, this.accountId) as ImageRow | undefined;

    if (!row) {
      return null;
    }

    const data = await readFile(this.absolutePath(row.relative_path)).catch(() => null);
    if (!data) {
      return null;
    }

    return { id: row.id, mimeType: row.mime_type, dataBase64: data.toString("base64") };
  }

  /** Removes the folder holding a conversation's images; rows cascade with it. */
  async deleteForConversation(conversationId: string): Promise<void> {
    const id = conversationId.trim();
    if (id.length === 0) {
      return;
    }

    await rm(join(this.rootDir, id), { recursive: true, force: true });
  }

  /** Account deletion: the database cascade cannot remove bytes on disk. */
  async deleteAllForAccount(): Promise<void> {
    await rm(this.rootDir, { recursive: true, force: true });
  }

  private absolutePath(relativePath: string): string {
    const absolute = resolve(this.rootDir, relativePath);
    const root = resolve(this.rootDir);

    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
      throw invalid("Image path escapes the image store.");
    }

    return absolute;
  }
}

function toChatImage(row: ImageRow): ChatImage {
  return { id: row.id, mimeType: row.mime_type, width: row.width, height: row.height };
}

/** Accepts raw base64 and tolerates a `data:` prefix from a file input. */
function decodeImage(dataBase64: string): Buffer {
  const payload = dataBase64.startsWith("data:")
    ? dataBase64.slice(dataBase64.indexOf(",") + 1)
    : dataBase64;
  const compact = payload.replace(/\s+/g, "");

  if (compact.length === 0) {
    throw invalid("The image is empty.");
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw invalid("The image payload is not valid base64.");
  }

  // Check the encoded size first: decoding a huge string just to discover it is
  // too large doubles the memory cost of a rejected upload.
  if (Math.ceil((compact.length * 3) / 4) > MAX_IMAGE_BYTES + 2) {
    throw invalid(`Images must be ${MAX_MEGABYTES} MB or smaller.`);
  }

  return Buffer.from(compact, "base64");
}

/**
 * Reads width and height from the file header. Doing it here rather than trusting
 * a renderer-supplied value means the stored metadata always matches the bytes
 * that were actually saved.
 */
export function readImageDimensions(
  buffer: Buffer,
  mimeType: ImageMimeType
): { width: number; height: number } {
  switch (mimeType) {
    case "image/png":
      return pngDimensions(buffer);
    case "image/jpeg":
      return jpegDimensions(buffer);
    case "image/webp":
      return webpDimensions(buffer);
  }
}

function positive(size: { width: number; height: number }, mimeType: string): {
  width: number;
  height: number;
} {
  if (size.width <= 0 || size.height <= 0) {
    throw invalid(`The ${mimeType} image reports an empty size.`);
  }

  return size;
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < 24 || !signature.every((byte, index) => buffer[index] === byte)) {
    throw invalid("That file is not a PNG image.");
  }

  return positive(
    { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) },
    "PNG"
  );
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw invalid("That file is not a JPEG image.");
  }

  let offset = 2;

  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1] as number;

    // Fill bytes and standalone markers carry no length field.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }

    if (offset + 3 >= buffer.length) {
      break;
    }

    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) {
      break;
    }

    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isStartOfFrame) {
      if (offset + 8 >= buffer.length) {
        break;
      }

      return positive(
        { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) },
        "JPEG"
      );
    }

    offset += 2 + length;
  }

  throw invalid("That JPEG image has no readable size.");
}

function webpDimensions(buffer: Buffer): { width: number; height: number } {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw invalid("That file is not a WebP image.");
  }

  const chunk = buffer.toString("ascii", 12, 16);

  // Extended format: 24-bit sizes minus one, after the flags block.
  if (chunk === "VP8X") {
    return positive(
      { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) },
      "WebP"
    );
  }

  // Lossless: a 14-bit pair packed after the 0x2f signature byte.
  if (chunk === "VP8L") {
    if (buffer[20] !== 0x2f) {
      throw invalid("That WebP image has an unreadable header.");
    }

    const bits = buffer.readUInt32LE(21);
    return positive(
      { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 },
      "WebP"
    );
  }

  // Lossy: keyframe signature then two 14-bit sizes.
  if (chunk === "VP8 ") {
    if (!(buffer[20] === 0x9d && buffer[21] === 0x01 && buffer[22] === 0x2a)) {
      throw invalid("That WebP image has an unreadable header.");
    }

    return positive(
      { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff },
      "WebP"
    );
  }

  throw invalid("That WebP image uses an unsupported encoding.");
}

export function isSupportedImageMimeType(value: string): boolean {
  return imageMimeTypeSchema.safeParse(value).success;
}
