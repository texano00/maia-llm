import { IMAGE_MIME_TYPES, MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES } from "@maia/contracts";

export type SupportedImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

/** An image the user picked but has not sent yet. */
export interface PendingImage {
  id: string;
  mimeType: SupportedImageMimeType;
  dataBase64: string;
  name: string;
}

export type AttachResult = { ok: true; image: PendingImage } | { ok: false; error: string };

/** `accept` for the file picker, derived from the same list the store enforces. */
export const IMAGE_ACCEPT = IMAGE_MIME_TYPES.join(",");

const MAX_MEGABYTES = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));

export function isSupportedImageType(mimeType: string): mimeType is SupportedImageMimeType {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Only vision runs accept pixels; a text model would silently ignore them. */
export function canAttachImages(session: { capability: string } | null | undefined): boolean {
  return session?.capability === "image-to-text";
}

/** Base64 without the `data:` prefix, chunked so a large image cannot blow the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

export function dataUrlFor(mimeType: string, dataBase64: string): string {
  return `data:${mimeType};base64,${dataBase64}`;
}

/**
 * Validates one picked file before it reaches the main process, so an obvious
 * mistake (wrong format, too large, too many) is reported instantly instead of
 * failing after the whole upload.
 */
export async function readImageFile(
  file: { name?: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> },
  existingCount: number,
  makeId: () => string = () => globalThis.crypto.randomUUID()
): Promise<AttachResult> {
  if (existingCount >= MAX_IMAGES_PER_MESSAGE) {
    return { ok: false, error: `You can attach up to ${MAX_IMAGES_PER_MESSAGE} images per message.` };
  }

  if (!isSupportedImageType(file.type)) {
    return { ok: false, error: "Only PNG, JPEG and WebP images can be attached." };
  }

  if (file.size <= 0) {
    return { ok: false, error: "That file is empty." };
  }

  if (file.size > MAX_IMAGE_BYTES) {
    return { ok: false, error: `Images must be ${MAX_MEGABYTES} MB or smaller.` };
  }

  const buffer = await file.arrayBuffer();
  const dataBase64 = bytesToBase64(new Uint8Array(buffer));

  if (dataBase64.length === 0) {
    return { ok: false, error: "That file is empty." };
  }

  return {
    ok: true,
    image: {
      id: makeId(),
      mimeType: file.type,
      dataBase64,
      name: file.name ?? "image"
    }
  };
}
