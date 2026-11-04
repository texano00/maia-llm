/**
 * Lightweight formatting for reasoning ("thinking") streams.
 *
 * Models write their thinking as Markdown-ish prose: paragraphs, bullet lists and
 * fenced code. Rendering that as `<p>{text}</p>` turns every snippet into a wall
 * of pre-wrapped text, so it is split into blocks here and rendered by
 * `ReasoningText`. No HTML is produced: everything ends up as React text nodes.
 */

export type ReasoningBlock =
  | { kind: "code"; language: string | null; code: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "paragraph"; text: string };

export type InlineToken = { kind: "text" | "code" | "strong"; value: string };

const FENCE = /^\s*```(.*)$/;
const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

/**
 * Splits a reasoning stream into renderable blocks.
 *
 * A fence that has not been closed yet (the model is still writing it) is kept as
 * a code block so the partial snippet already appears in a monospace panel.
 */
export function splitReasoning(source: string): ReasoningBlock[] {
  const blocks: ReasoningBlock[] = [];
  const lines = source.split("\n");

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
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
      blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
    }
    list = null;
  };

  const flushText = (): void => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
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
      fence = { language: fenceMatch[1]?.trim() || null, code: [] };
      continue;
    }

    if (line.trim().length === 0) {
      flushText();
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      flushParagraph();
      if (list && list.ordered !== ordered) {
        flushList();
      }
      list ??= { ordered, items: [] };
      list.items.push(line.replace(ordered ? NUMBERED : BULLET, ""));
      continue;
    }

    if (list) {
      // A wrapped continuation of the previous bullet stays in that item.
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

/** Inline `code` and **bold** spans, which models use constantly in reasoning. */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ kind: "text", value: text.slice(cursor, index) });
    }

    tokens.push(
      match[1] !== undefined
        ? { kind: "code", value: match[1] }
        : { kind: "strong", value: match[2] ?? "" }
    );
    cursor = index + match[0].length;
  }

  if (cursor < text.length) {
    tokens.push({ kind: "text", value: text.slice(cursor) });
  }

  return tokens;
}

function normalizeLanguage(language: string | null | undefined): string | null {
  if (!language) {
    return null;
  }

  const cleaned = language.trim().toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}
