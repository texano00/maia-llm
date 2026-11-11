import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The promise is a product requirement, not copywriting: it must appear before
 * the download call to action and no surface may ask for an account, an email
 * address or a newsletter subscription.
 */
const ROOT = process.cwd();
const SURFACES = ["README.md", "infra/landing/index.html"] as const;

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("privacy promise", () => {
  it.each(SURFACES)("%s states the promise before the download link", (surface) => {
    const content = read(surface).toLowerCase();
    const promiseIndex = Math.max(
      content.indexOf("no account"),
      content.indexOf("free and fully open")
    );
    const downloadIndex = Math.max(
      content.indexOf("download"),
      content.indexOf("releases/latest")
    );

    expect(promiseIndex).toBeGreaterThan(-1);
    expect(colorMatches(content, "no data selling")).toBe(true);
    expect(downloadIndex).toBeGreaterThan(-1);
    expect(promiseIndex).toBeLessThan(downloadIndex);
  });

  it.each(SURFACES)("%s has no Maia account or newsletter affordance", (surface) => {
    const content = read(surface).toLowerCase();
    // Provider sites may ask the visitor to sign in; the product itself never does.
    for (const forbidden of [
      "create an account",
      "maia account",
      "login to maia",
      "newsletter",
      "subscribe"
    ]) {
      expect(content).not.toContain(forbidden);
    }
  });
});

function colorMatches(content: string, phrase: string): boolean {
  return content.includes(phrase);
}
