import { describe, expect, it } from "vitest";
import {
  USAGE_SAMPLE_KEYS as DESKTOP_KEYS,
  usageSampleSchema as desktopSchema
} from "@maia/contracts";
import {
  USAGE_SAMPLE_KEYS as SERVER_KEYS,
  usageSampleSchema as serverSchema
} from "../../src/usage-schema";

const VALID = {
  installationId: "11111111-1111-4111-8111-111111111111",
  appVersion: "0.8.4",
  os: "windows",
  osVersion: "11",
  arch: "x64",
  deviceClass: "desktop",
  modelId: "Qwen/Qwen2.5-7B-Instruct",
  capability: "text",
  outputTokens: 512,
  generationMs: 10_000,
  tokensPerSecond: 51.2,
  outcome: "completed",
  occurredAt: "2026-11-11T10:00:00.000Z"
};

describe("usage sample allowlist", () => {
  it("keeps the desktop and portal key sets identical", () => {
    expect([...SERVER_KEYS].sort()).toEqual([...DESKTOP_KEYS].sort());
  });

  it("keeps the desktop schema free of content fields", () => {
    expect(Object.keys(desktopSchema.shape).sort()).toEqual([...DESKTOP_KEYS].sort());
  });

  it("accepts an allowlisted sample", () => {
    expect(serverSchema.safeParse(VALID).success).toBe(true);
    expect(desktopSchema.safeParse(VALID).success).toBe(true);
  });

  it.each(["prompt", "response", "content", "image", "path", "apiKey", "token"])(
    "rejects a sample carrying %s",
    (key) => {
      expect(serverSchema.safeParse({ ...VALID, [key]: "leak" }).success).toBe(false);
      expect(desktopSchema.safeParse({ ...VALID, [key]: "leak" }).success).toBe(false);
    }
  );

  it("rejects an installation id that is not a UUID", () => {
    expect(serverSchema.safeParse({ ...VALID, installationId: "device-1" }).success).toBe(false);
  });
});
