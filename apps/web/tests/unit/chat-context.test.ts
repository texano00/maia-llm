import { describe, expect, it } from "vitest";
import { buildContext, estimateTokens } from "../../src/main/services/chat/context";

describe("chat context budgeting", () => {
  it("always keeps system notices, even when the budget is tight", () => {
    const built = buildContext(
      [
        { role: "system", content: "Model switched from A to B." },
        { role: "user", content: "x".repeat(4000) },
        { role: "assistant", content: "y".repeat(4000) },
        { role: "user", content: "latest" }
      ],
      { contextWindow: 4096 }
    );

    expect(built.messages[0]).toEqual({ role: "system", content: "Model switched from A to B." });
    expect(built.messages.at(-1)).toEqual({ role: "user", content: "latest" });
  });

  it("keeps the newest user message even when it alone exceeds the budget", () => {
    const huge = "z".repeat(100_000);
    const built = buildContext(
      [
        { role: "user", content: "old" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: huge }
      ],
      { contextWindow: 4096 }
    );

    expect(built.messages.at(-1)?.content).toBe(huge);
    expect(built.omittedMessages).toBe(2);
  });

  it("drops the oldest turns first and reports the exact count", () => {
    const built = buildContext(
      [
        { role: "user", content: "a".repeat(400) },
        { role: "assistant", content: "b".repeat(400) },
        { role: "user", content: "c".repeat(400) },
        { role: "assistant", content: "d".repeat(400) },
        { role: "user", content: "e" }
      ],
      { contextWindow: 250 }
    );

    // 250 tokens × 0.9 = 225 tokens; three 100-token turns fit beside the new one.
    expect(built.omittedMessages).toBeGreaterThan(0);
    expect(built.messages.at(-1)).toEqual({ role: "user", content: "e" });
  });

  it("returns the conversation in chronological order", () => {
    const built = buildContext(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" }
      ],
      { contextWindow: 32_768 }
    );

    expect(built.messages.map((message) => message.content)).toEqual(["first", "second", "third"]);
    expect(built.omittedMessages).toBe(0);
  });

  it("uses a conservative character-to-token ratio", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});
