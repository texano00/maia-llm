/**
 * A small Markdown reader for model output.
 *
 * Models answer in Markdown: headings, bullet lists, tables, fenced code and
 * inline spans. Rendering that as `<p>{content}</p>` showed the raw markers and
 * collapsed every snippet into one pre-wrapped blob, which is unreadable for the
 * shell commands and diffs the models produce most often.
 *
 * This module only *splits* the text. No HTML is produced anywhere: blocks are
 * turned into React elements by `MessageContent`, so a hostile answer cannot
 * inject markup.
 */

export type MarkdownBlock =
  | { kind: "code"; language: string | null; code: string }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "rule" };

export type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "strong"; value: string }
  | { kind: "emphasis"; value: string }
  | { kind: "link"; value: string; href: string };

const FENCE = /^\s*(```|~~~)\s*(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * Splits a stream (possibly still being written) into blocks.
 *
 * An unterminated fence stays a code block, so a snippet already appears in a
 * monospace panel while the model is still typing it.
 */
export function splitMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source.split("\n");

  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  let quote: string[] | null = null;
  let fence: { language: string | null; code: string[] } | null = null;

  const flushParagraph = (): void => {
    const text = paragraph.join("\n").trim();
    if (text.length > 0) {
      blocks.push({ kind: "paragraph", text });
    }
    paragraph = [];
  };

  const flushList = (): void => {
    if (list && list.items.length > 0) {
      blocks.push({ kind: "list", ordered: list.ordered, start: list.start, items: list.items });
    }
    list = null;
  };

  const flushQuote = (): void => {
    const text = quote?.join("\n").trim() ?? "";
    if (text.length > 0) {
      blocks.push({ kind: "quote", text });
    }
    quote = null;
  };

  const flushText = (): void => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = FENCE.exec(line);

    if (fence) {
      if (fenceMatch) {
        blocks.push({
          kind: "code",
          language: normalizeLanguage(fence.language),
          code: fence.code.join("\n")
        });
        fence = null;
      } else {
        fence.code.push(line);
      }
      continue;
    }

    if (fenceMatch) {
      flushText();
      fence = { language: fenceMatch[2]?.trim() || null, code: [] };
      continue;
    }

    if (line.trim().length === 0) {
      flushText();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushText();
      blocks.push({
        kind: "heading",
        level: clampHeading(heading[1]?.length ?? 1),
        text: heading[2]?.trim() ?? ""
      });
      continue;
    }

    if (RULE.test(line)) {
      flushText();
      blocks.push({ kind: "rule" });
      continue;
    }

    const quoted = QUOTE.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      quote ??= [];
      quote.push(quoted[1] ?? "");
      continue;
    }

    // A table needs its divider row to be recognised as one; without it the
    // pipes are ordinary prose.
    if (line.includes("|") && TABLE_DIVIDER.test(lines[index + 1] ?? "")) {
      flushText();
      const head = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        rows.push(splitTableRow(lines[index] ?? ""));
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = numbered !== null;
      flushParagraph();
      flushQuote();
      if (list && list.ordered !== ordered) {
        flushList();
      }
      list ??= { ordered, start: ordered ? Number(numbered?.[2] ?? 1) : 1, items: [] };
      const text = ordered ? numbered?.[3] ?? "" : bullet?.[2] ?? "";
      list.items.push(text.trim());
      continue;
    }

    if (list) {
      // A wrapped continuation of the previous item stays inside it.
      const last = list.items.length - 1;
      if (last >= 0 && /^\s{2,}/.test(line)) {
        list.items[last] = `${list.items[last]} ${line.trim()}`;
        continue;
      }
      flushList();
    }

    paragraph.push(line);
  }

  if (fence) {
    blocks.push({
      kind: "code",
      language: normalizeLanguage(fence.language),
      code: fence.code.join("\n")
    });
  }
  flushText();

  return blocks;
}

/** Inline `code`, **bold**, *emphasis* and [links](https://example.com). */
export function parseInlineMarkdown(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ kind: "text", value: text.slice(cursor, index) });
    }

    if (match[1] !== undefined) {
      tokens.push({ kind: "code", value: match[1] });
    } else if (match[2] !== undefined || match[3] !== undefined) {
      tokens.push({ kind: "strong", value: match[2] ?? match[3] ?? "" });
    } else if (match[4] !== undefined || match[5] !== undefined) {
      tokens.push({ kind: "emphasis", value: match[4] ?? match[5] ?? "" });
    } else {
      tokens.push({ kind: "link", value: match[6] ?? "", href: match[7] ?? "" });
    }

    cursor = index + match[0].length;
  }

  if (cursor < text.length) {
    tokens.push({ kind: "text", value: text.slice(cursor) });
  }

  return tokens;
}

/** Strips the markers the inline parser understands, for plain-text contexts. */
export function toPlainText(text: string): string {
  return parseInlineMarkdown(text)
    .map((token) => token.value)
    .join("");
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function clampHeading(level: number): 1 | 2 | 3 | 4 | 5 | 6 {
  const clamped = Math.min(6, Math.max(1, level));
  return clamped as 1 | 2 | 3 | 4 | 5 | 6;
}

function normalizeLanguage(language: string | null | undefined): string | null {
  if (!language) {
    return null;
  }

  const cleaned = language.trim().toLowerCase().split(/\s+/)[0] ?? "";
  return cleaned.length > 0 ? cleaned : null;
}
