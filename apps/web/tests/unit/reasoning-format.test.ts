import { describe, expect, it } from "vitest";
import { parseInline, splitReasoning } from "../../src/renderer/features/chat/reasoning-format";

describe("reasoning formatting", () => {
  it("splits prose and fenced code", () => {
    const blocks = splitReasoning(
      "I should check the value.\n\n```python\nprint('hi')\n```\n\nThen answer."
    );

    expect(blocks).toEqual([
      { kind: "paragraph", text: "I should check the value." },
      { kind: "code", language: "python", code: "print('hi')" },
      { kind: "paragraph", text: "Then answer." }
    ]);
  });

  it("keeps an unterminated fence as code while the model is still writing", () => {
    const blocks = splitReasoning("```ts\nconst a = 1;\nconst b =");

    expect(blocks).toEqual([
      { kind: "code", language: "ts", code: "const a = 1;\nconst b =" }
    ]);
  });

  it("groups bullets and numbers into lists", () => {
    const blocks = splitReasoning("- first point\n- second point\n\n1. do this\n2. then that");

    expect(blocks).toEqual([
      { kind: "list", ordered: false, items: ["first point", "second point"] },
      { kind: "list", ordered: true, items: ["do this", "then that"] }
    ]);
  });

  it("keeps indented continuation lines inside a bullet", () => {
    const blocks = splitReasoning("- a long point\n  that wraps");

    expect(blocks).toEqual([{ kind: "list", ordered: false, items: ["a long point that wraps"] }]);
  });

  it("flags inline code and bold runs", () => {
    expect(parseInline("call `foo()` and **verify** it")).toEqual([
      { kind: "text", value: "call " },
      { kind: "code", value: "foo()" },
      { kind: "text", value: " and " },
      { kind: "strong", value: "verify" },
      { kind: "text", value: " it" }
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(splitReasoning("")).toEqual([]);
    expect(parseInline("")).toEqual([]);
  });
});
