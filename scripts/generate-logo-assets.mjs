import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

/**
 * Regenerates every derived logo file from the transparent source artwork in
 * `assets/logo.png`. Run after the artwork changes:
 *
 *   npm run assets:logo
 *
 * - README header keeps its aspect ratio.
 * - The Windows icon and the sidebar mark are padded to a square so neither is
 *   stretched; the padding is transparent, which both targets support.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(repoRoot, "assets/logo.png");

const targets = [
  { file: "docs/logo.png", width: 560, square: false },
  { file: "apps/desktop/resources/icon.png", size: 512, square: true },
  { file: "apps/desktop/src/renderer/assets/logo-mark.png", size: 128, square: true },
];

async function main() {
  const trimmed = await sharp(source).trim({ threshold: 10 }).png().toBuffer();

  for (const target of targets) {
    const destination = resolve(repoRoot, target.file);
    mkdirSync(dirname(destination), { recursive: true });

    if (target.square) {
      const size = target.size ?? target.width;
      await sharp(trimmed)
        .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9, palette: true, quality: 92 })
        .toFile(destination);
      console.log(`square  ${target.file} -> ${size}x${size}`);
      continue;
    }

    await sharp(trimmed)
      .resize({ width: target.width })
      .png({ compressionLevel: 9, palette: true, quality: 92 })
      .toFile(destination);
    const meta = await sharp(destination).metadata();
    console.log(`aspect  ${target.file} -> ${meta.width}x${meta.height}`);
  }
}

void main();
