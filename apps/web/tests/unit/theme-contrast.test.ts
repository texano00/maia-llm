import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The light palette is the default now, so readability has to be a build
 * assertion rather than a review opinion. Reads the token blocks from
 * `theme.css` and checks WCAG AA for the documented text/background pairs.
 */

const CSS = readFileSync(
  join(process.cwd(), "apps/web/src/renderer/shared/theme.css"),
  "utf8"
);

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

function block(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  if (start < 0) {
    throw new Error(`token block not found: ${selector}`);
  }

  const end = CSS.indexOf("\n}", start);
  const body = CSS.slice(start, end);
  const tokens: Record<string, string> = {};

  for (const match of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    tokens[match[1]!] = match[2]!.trim();
  }

  return tokens;
}

function parseColor(value: string): Rgb {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const int = Number.parseInt(hex[1]!, 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, a: 1 };
  }

  const short = value.match(/^#([0-9a-f]{3})$/i);
  if (short) {
    const digits = short[1]!;
    return {
      r: Number.parseInt(digits[0]! + digits[0]!, 16),
      g: Number.parseInt(digits[1]! + digits[1]!, 16),
      b: Number.parseInt(digits[2]! + digits[2]!, 16),
      a: 1
    };
  }

  const rgb = value.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)%)?\s*\)$/);
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]) / 100
    };
  }

  throw new Error(`unsupported colour: ${value}`);
}

function over(foreground: Rgb, background: Rgb): Rgb {
  return {
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a),
    a: 1
  };
}

function luminance(colour: Rgb): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b);
}

function contrast(foreground: string, background: string): number {
  const surface = parseColor(background);
  const ink = over(parseColor(foreground), surface);
  const [light, dark] =
    luminance(ink) > luminance(surface)
      ? [luminance(ink), luminance(surface)]
      : [luminance(surface), luminance(ink)];

  return (light + 0.05) / (dark + 0.05);
}

const PALETTES = [
  { name: "light", selector: ":root" },
  { name: "dark", selector: ':root[data-theme="dark"]' }
] as const;

/** Pairs that must meet WCAG AA for body text (4.5:1). */
const TEXT_PAIRS = [
  ["text", "surface-1"],
  ["text", "surface-0"],
  ["text", "surface-2"],
  ["text-muted", "surface-1"],
  ["text-faint", "surface-1"],
  ["accent-strong", "surface-1"],
  ["danger-text", "surface-1"],
  ["warning-text", "surface-1"],
  ["success-text", "surface-1"],
  ["text-on-accent", "accent"]
] as const;

describe("theme contrast", () => {
  for (const palette of PALETTES) {
    const tokens = { ...block(":root"), ...block(palette.selector) };

    for (const [ink, surface] of TEXT_PAIRS) {
      it(`${palette.name}: --${ink} on --${surface} meets AA`, () => {
        const value = contrast(tokens[ink]!, tokens[surface]!);
        expect(
          value,
          `${ink} (${tokens[ink]}) on ${surface} (${tokens[surface]}) = ${value.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("defines the same token names in both palettes", () => {
    const light = Object.keys(block(":root"));
    const dark = Object.keys(block(':root[data-theme="dark"]'));

    // The dark block overrides a subset; nothing may be defined only there.
    expect(dark.filter((name) => !light.includes(name))).toEqual([]);
  });

  it("keeps code surfaces dark and independent of the palette", () => {
    const light = block(":root");
    const dark = block(':root[data-theme="dark"]');
    const surface = parseColor(light["code-surface"]!);

    expect(Math.max(surface.r, surface.g, surface.b)).toBeLessThan(40);
    expect(
      Object.keys(dark).filter((name) => name.startsWith("code-") || name.startsWith("syn-"))
    ).toEqual([]);
  });
});
