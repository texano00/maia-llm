import { describe, expect, it } from "vitest";
import {
  chatEditSchema,
  chatRegenerateSchema,
  restartRequestSchema,
  runtimeConfigSchema,
  sessionStartSchema
} from "@maia/contracts";

const values = { contextWindow: 32768, maxConcurrentRequests: 2 };

describe("runtime config contract", () => {
  it("accepts a configuration with a documented model maximum", () => {
    const parsed = runtimeConfigSchema.parse({
      current: values,
      defaults: { contextWindow: 8192, maxConcurrentRequests: 1 },
      contextWindowMax: 131072,
      contextWindowMaxSource: "model",
      concurrencyMax: 4,
      estimatedMaxContext: 40960,
      fits: true,
      restart: null
    });

    expect(parsed.contextWindowMaxSource).toBe("model");
  });

  it("rejects a context window below the planner floor", () => {
    expect(() =>
      runtimeConfigSchema.parse({
        current: { contextWindow: 512, maxConcurrentRequests: 1 },
        defaults: { contextWindow: 4096, maxConcurrentRequests: 1 },
        contextWindowMax: null,
        contextWindowMaxSource: "product",
        concurrencyMax: 1,
        estimatedMaxContext: 4096,
        fits: true,
        restart: null
      })
    ).toThrow();
  });

  it("rejects more than eight concurrent requests", () => {
    expect(() =>
      runtimeConfigSchema.parse({
        current: { contextWindow: 8192, maxConcurrentRequests: 9 },
        defaults: { contextWindow: 8192, maxConcurrentRequests: 1 },
        contextWindowMax: null,
        contextWindowMaxSource: "product",
        concurrencyMax: 1,
        estimatedMaxContext: 8192,
        fits: true,
        restart: null
      })
    ).toThrow();
  });

  it("requires an explicit restart confirmation", () => {
    expect(() =>
      restartRequestSchema.parse({
        sessionId: "s1",
        confirmRestart: false,
        values
      })
    ).toThrow();

    expect(restartRequestSchema.parse({ sessionId: "s1", confirmRestart: true, values })).toEqual({
      sessionId: "s1",
      confirmRestart: true,
      values
    });
  });

  it("no longer accepts a context window at start", () => {
    const parsed = sessionStartSchema.parse({ estimateId: "e1", confirmEstimate: true });
    expect(parsed).not.toHaveProperty("generation");
  });
});

describe("chat turn contract", () => {
  it("requires a message id for regenerate and edit", () => {
    expect(() =>
      chatRegenerateSchema.parse({ sessionId: "s1", conversationId: "c1" })
    ).toThrow();
    expect(() =>
      chatEditSchema.parse({ sessionId: "s1", conversationId: "c1", userMessageId: "m1" })
    ).toThrow();
  });

  it("accepts an edited turn", () => {
    const parsed = chatEditSchema.parse({
      sessionId: "s1",
      conversationId: "c1",
      userMessageId: "m1",
      content: "Try again with less detail"
    });
    expect(parsed.content).toBe("Try again with less detail");
  });
});
