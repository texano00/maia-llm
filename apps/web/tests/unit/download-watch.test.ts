import { describe, expect, it } from "vitest";
import { buildWeightWatchScript, shellQuote } from "../../src/main/services/inference/download-watch";
import { bootPercent, summarizeBootLog } from "../../src/main/services/sessions/boot-log";

/**
 * llama.cpp writes its download bar with a carriage return and no newline, so a
 * 16 GB download leaves the container log at four lines for half an hour and the
 * run card with nothing to say. The wrapper prints a percentage the existing
 * boot-log parser already understands.
 */
describe("weight watch script", () => {
  const script = buildWeightWatchScript({
    serverPath: "/app/llama-server",
    args: ["-hf", "org/model-GGUF:Q4_K_M", "-hff", "model-Q4_K_M.gguf", "--api-key", "maia_abc"],
    expectedBytes: 16_547_400_032,
    cacheDir: "/models"
  });

  it("starts the engine with the model reference and keeps its key quoted out of the shell", () => {
    expect(script).toContain("/app/llama-server -hf org/model-GGUF:Q4_K_M -hff model-Q4_K_M.gguf");
    expect(script).toContain("--api-key maia_abc");
    // Quoting is used only when needed, and a key with a quote survives it.
    expect(shellQuote("org/model-GGUF:Q4_K_M")).toBe("org/model-GGUF:Q4_K_M");
    expect(shellQuote("a b'c")).toBe("'a b'\\''c'");
  });

  it("measures the cache the engine downloads into", () => {
    expect(script).toContain("export LLAMA_CACHE=/models");
    expect(script).toContain("du -sb /models");
    expect(script).toContain("expected=16547400032");
  });

  it("prints a percentage the boot-log parser reads as progress", () => {
    // The line the watcher emits once a quarter of the file has arrived.
    expect(script).toContain('echo "downloading the model ($pct%)"');

    const line = "downloading the model (25%)";
    expect(bootPercent(line)).toBe(25);
    expect(summarizeBootLog(line)).toContain("25%");
  });

  it("falls back to megabytes when the file size is unknown", () => {
    const unknown = buildWeightWatchScript({
      serverPath: "/app/llama-server",
      args: ["-hf", "org/model"],
      expectedBytes: null,
      cacheDir: "/models"
    });

    // No size, no percentage: the watcher still says how much has arrived.
    expect(unknown).toContain("expected=0");
    expect(unknown).toContain("downloading the model ($((have / 1000000)) MB)");
  });

  it("writes an error line and stops the container when the server dies", () => {
    // A dead server behind a live container would keep billing with no model;
    // the readiness loop reads an error line in the log as a verdict.
    expect(script).toContain('echo "error: the model server exited with status $status"');
    expect(script).toContain("kill 1");
  });
});
