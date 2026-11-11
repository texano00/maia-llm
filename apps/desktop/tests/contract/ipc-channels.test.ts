import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ipcChannels } from "@maia/contracts";

/**
 * Contract guard: every allowlisted channel must have a registration in the main
 * process. A channel in the allowlist with no handler fails at runtime with
 * "Unsupported IPC channel", which is only discoverable by clicking through the
 * app, so it is asserted here instead.
 */
const MAIN_ROOT = join(process.cwd(), "apps/desktop/src/main");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Channels allowlisted ahead of their story. Empty now that every channel is
 * registered; keep the mechanism so a future story can declare one explicitly.
 */
const PENDING_CHANNELS = new Set<string>();

describe("IPC channel contract", () => {
  const sources = sourceFiles(MAIN_ROOT)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  it("registers every allowlisted channel in the main process", () => {
    const missing = ipcChannels.filter(
      (channel) =>
        !PENDING_CHANNELS.has(channel) &&
        !sources.includes(`register("${channel}"`) &&
        !sources.includes(`register(\n    "${channel}"`)
    );

    expect(missing).toEqual([]);
  });

  it("keeps the allowlist free of duplicates", () => {
    expect(new Set(ipcChannels).size).toBe(ipcChannels.length);
  });
});
