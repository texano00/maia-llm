import { describe, expect, it } from "vitest";
import { MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES } from "@maia/contracts";
import {
  IMAGE_ACCEPT,
  bytesToBase64,
  canAttachImages,
  dataUrlFor,
  isSupportedImageType,
  readImageFile
} from "../../src/renderer/features/chat/attachments";

function blobOf(bytes: Uint8Array, type: string): Blob {
  return new Blob([bytes], { type });
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("chat attachments", () => {
  it("accepts a supported image and encodes it as bare base64", async () => {
    const result = await readImageFile(blobOf(PNG_BYTES, "image/png"), 0, () => "id-1");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.image).toMatchObject({ id: "id-1", mimeType: "image/png" });
    expect(result.image.dataBase64).toBe(bytesToBase64(PNG_BYTES));
    // No `data:` prefix: the transport adds it back when the bytes are needed.
    expect(result.image.dataBase64.startsWith("data:")).toBe(false);
  });

  it("refuses a format the store would reject anyway", async () => {
    const result = await readImageFile(blobOf(PNG_BYTES, "image/gif"), 0);
    expect(result).toEqual({ ok: false, error: "Only PNG, JPEG and WebP images can be attached." });
  });

  it("refuses an empty file", async () => {
    const result = await readImageFile(blobOf(new Uint8Array(), "image/png"), 0);
    expect(result).toEqual({ ok: false, error: "That file is empty." });
  });

  it("refuses a file above the 20 MB cap before reading it", async () => {
    const result = await readImageFile(
      { name: "huge.png", type: "image/png", size: MAX_IMAGE_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) },
      0
    );

    expect(result).toEqual({ ok: false, error: "Images must be 20 MB or smaller." });
  });

  it("refuses a fifth image in one turn", async () => {
    const result = await readImageFile(blobOf(PNG_BYTES, "image/png"), MAX_IMAGES_PER_MESSAGE);
    expect(result).toEqual({
      ok: false,
      error: `You can attach up to ${MAX_IMAGES_PER_MESSAGE} images per message.`
    });
  });

  it("only offers the picker to vision runs", () => {
    expect(canAttachImages({ capability: "image-to-text" })).toBe(true);
    expect(canAttachImages({ capability: "text" })).toBe(false);
    expect(canAttachImages({ capability: "text-to-image" })).toBe(false);
    expect(canAttachImages(null)).toBe(false);
  });

  it("builds the data URL and accept list from the shared contract", () => {
    expect(dataUrlFor("image/webp", "AAAA")).toBe("data:image/webp;base64,AAAA");
    expect(IMAGE_ACCEPT).toBe("image/png,image/jpeg,image/webp");
    expect(isSupportedImageType("image/jpeg")).toBe(true);
    expect(isSupportedImageType("image/bmp")).toBe(false);
  });
});
