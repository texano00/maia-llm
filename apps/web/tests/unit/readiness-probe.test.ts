import { describe, expect, it } from "vitest";
import { describeCeiling, probeInference } from "../../src/main/services/sessions/readiness";

/**
 * Readiness is one produced token, not a health page (feature 011, FR-001).
 */
describe("probeInference", () => {
  const ok = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200 }) as Response;

  it("treats a chat completion as serving", async () => {
    const result = await probeInference({
      baseUrl: "http://203.0.113.5:30000",
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      apiKey: "k",
      fetchImpl: (async () => ok({ choices: [{ message: { role: "assistant", content: "" } }] })) as never
    });

    expect(result.kind).toBe("serving");
  });

  it("falls back to completions when a text-only model has no chat route", async () => {
    const calls: string[] = [];
    const result = await probeInference({
      baseUrl: "http://203.0.113.5:30000",
      modelId: "org/text-model",
      apiKey: "k",
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        return String(url).endsWith("/v1/chat/completions")
          ? (new Response("not found", { status: 404 }) as Response)
          : ok({ choices: [{ text: "" }] });
      }) as never
    });

    expect(result.kind).toBe("serving");
    expect(calls).toHaveLength(2);
  });

  it("keeps waiting while the engine is still loading", async () => {
    const result = await probeInference({
      baseUrl: "http://203.0.113.5:30000",
      modelId: "x",
      apiKey: "k",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as never
    });

    expect(result).toEqual({ kind: "waiting", answered: false });
  });

  it("carries the engine's own words when it answers but cannot serve yet", async () => {
    // What llama.cpp actually answers while it loads a GGUF.
    const result = await probeInference({
      baseUrl: "http://203.0.113.5:30000",
      modelId: "x",
      apiKey: "k",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: "Loading model" } }), {
          status: 503
        })) as never
    });

    expect(result).toEqual({ kind: "waiting", answered: true, detail: "Loading model" });
  });

  it("reports a model the endpoint refuses to serve", async () => {
    const result = await probeInference({
      baseUrl: "http://203.0.113.5:30000",
      modelId: "x",
      apiKey: "k",
      fetchImpl: (async () => new Response("not found", { status: 404 })) as never
    });

    expect(result).toMatchObject({ kind: "failed", reason: "model_load_failed" });
  });
});

describe("describeCeiling", () => {
  it("says the GPU is still rented and names the phase", () => {
    const sentence = describeCeiling({
      elapsedMs: 61 * 60_000,
      ceilingMs: 60 * 60_000,
      phase: "downloading the model (87%)"
    });

    expect(sentence).toContain("past the 60-minute ceiling");
    expect(sentence).toContain("still rented");
    expect(sentence).toContain("87%");
  });
});
