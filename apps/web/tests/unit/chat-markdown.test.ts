import { describe, expect, it } from "vitest";
import {
  parseInlineMarkdown,
  splitMarkdown,
  toPlainText
} from "../../src/renderer/features/chat/markdown";
import { highlightCode, languageLabel } from "../../src/renderer/features/chat/highlight";

describe("chat markdown", () => {
  it("splits the blocks models actually emit", () => {
    const blocks = splitMarkdown(
      [
        "## Steps",
        "Build the binary:",
        "",
        "- run the compiler",
        "- then the tests",
        "",
        "1. first",
        "2. second",
        "",
        "> careful with the flags",
        "",
        "| Name | Value |",
        "| --- | --- |",
        "| gcc | 13 |",
        "",
        "---"
      ].join("\n")
    );

    expect(blocks[0]).toEqual({ kind: "heading", level: 2, text: "Steps" });
    expect(blocks[1]).toEqual({ kind: "paragraph", text: "Build the binary:" });
    expect(blocks[2]).toEqual({
      kind: "list",
      ordered: false,
      start: 1,
      items: ["run the compiler", "then the tests"]
    });
    expect(blocks[3]).toEqual({ kind: "list", ordered: true, start: 1, items: ["first", "second"] });
    expect(blocks[4]).toEqual({ kind: "quote", text: "careful with the flags" });
    expect(blocks[5]).toEqual({
      kind: "table",
      head: ["Name", "Value"],
      rows: [["gcc", "13"]]
    });
    expect(blocks[6]).toEqual({ kind: "rule" });
  });

  it("keeps a fence that is still being written as a code block", () => {
    const blocks = splitMarkdown("Here you go:\n```sh\ngcc hello_world.c -o hello_world");

    expect(blocks[0]).toEqual({ kind: "paragraph", text: "Here you go:" });
    // The snippet already appears in its panel instead of flashing as raw text.
    expect(blocks[1]).toEqual({
      kind: "code",
      language: "sh",
      code: "gcc hello_world.c -o hello_world"
    });
  });

  it("keeps a closed fence's language and code verbatim", () => {
    const blocks = splitMarkdown("```python\nprint('hi')\n```");

    expect(blocks).toEqual([{ kind: "code", language: "python", code: "print('hi')" }]);
  });

  it("parses inline spans without producing HTML", () => {
    const tokens = parseInlineMarkdown("use `gcc -o` and **be** *careful* [docs](https://x.dev/a)");

    expect(tokens).toEqual([
      { kind: "text", value: "use " },
      { kind: "code", value: "gcc -o" },
      { kind: "text", value: " and " },
      { kind: "strong", value: "be" },
      { kind: "text", value: " " },
      { kind: "emphasis", value: "careful" },
      { kind: "text", value: " " },
      { kind: "link", value: "docs", href: "https://x.dev/a" }
    ]);
    expect(toPlainText("**bold** and `code`")).toBe("bold and code");
  });
});

describe("chat code highlighting", () => {
  it("colours the shell snippet that prompted the feature", () => {
    const lines = highlightCode("gcc hello_world.c -o hello_world  # build it", "sh");
    const tokens = lines[0] ?? [];
    const types = tokens.map((token) => token.type);

    expect(tokens.map((token) => token.text).join("")).toBe(
      "gcc hello_world.c -o hello_world  # build it"
    );
    expect(tokens.find((token) => token.text === "gcc")?.type).toBe("builtin");
    expect(tokens.find((token) => token.text === "# build it")?.type).toBe("comment");
    expect(types).toContain("operator");
  });

  it("marks json keys as properties and keeps values as strings", () => {
    const tokens = highlightCode('{"model": "qwen", "stream": true}', "json").flat();

    expect(tokens.find((token) => token.text === '"model"')?.type).toBe("property");
    expect(tokens.find((token) => token.text === '"qwen"')?.type).toBe("string");
    expect(tokens.find((token) => token.text === "true")?.type).toBe("keyword");
  });

  it("colours diff lines by their prefix", () => {
    const lines = highlightCode("-old line\n+new line\n context", "diff");

    expect(lines[0]?.[0]?.type).toBe("removed");
    expect(lines[1]?.[0]?.type).toBe("added");
    expect(lines[2]?.[0]?.type).toBe("plain");
  });

  it("leaves an unknown language as plain text instead of guessing", () => {
    const lines = highlightCode("some ascii art >>><<<", "made-up-language");

    expect(lines).toEqual([[{ type: "plain", text: "some ascii art >>><<<" }]]);
    expect(languageLabel(null)).toBe("code");
    expect(languageLabel("ts")).toBe("ts");
  });

  it("keeps every character of the source", () => {
    const source = 'const value = `template ${1 + 2}`; // done\n/* block */\nlet x = 42;';
    const rendered = highlightCode(source, "ts")
      .map((line) => line.map((token) => token.text).join(""))
      .join("\n");

    expect(rendered).toBe(source);
  });
});
