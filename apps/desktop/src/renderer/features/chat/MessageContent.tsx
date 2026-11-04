import { createElement, Fragment, memo } from "react";
import {
  parseInlineMarkdown,
  splitMarkdown,
  type InlineToken,
  type MarkdownBlock
} from "./markdown";
import { CodeBlock } from "./CodeBlock";

interface MessageContentProps {
  text: string;
  /** Keeps the caret and the spacing of a bubble that is still filling. */
  streaming?: boolean;
}

/**
 * Renders model output as Markdown: headings, lists, quotes, tables, fenced
 * snippets with highlighting and copy, and inline spans.
 *
 * Everything is a React node — no `dangerouslySetInnerHTML` anywhere — so a model
 * that answers with `<script>` or a broken tag cannot break the transcript.
 */
export const MessageContent = memo(function MessageContent({
  text,
  streaming = false
}: MessageContentProps) {
  const blocks = splitMarkdown(text);

  return (
    <div className={streaming ? "message-content streaming" : "message-content"}>
      {blocks.map((block, index) => (
        <Fragment key={index}>{renderBlock(block)}</Fragment>
      ))}
      {streaming ? <span className="message-caret" aria-hidden="true" /> : null}
    </div>
  );
});

function renderBlock(block: MarkdownBlock) {
  switch (block.kind) {
    case "code":
      return <CodeBlock code={block.code} language={block.language} />;

    case "heading": {
      const tag = `h${block.level}` as const;
      return createElement(tag, { className: "md-heading" }, renderInline(block.text));
    }

    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag className="md-list" start={block.ordered ? block.start : undefined}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </Tag>
      );
    }

    case "quote":
      return <blockquote className="md-quote">{renderInline(block.text)}</blockquote>;

    case "table":
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index}>{renderInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{renderInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "rule":
      return <hr className="md-rule" />;

    default:
      return <p className="md-paragraph">{renderInline(block.text)}</p>;
  }
}

function renderInline(text: string) {
  return parseInlineMarkdown(text).map((token, index) => renderToken(token, index));
}

function renderToken(token: InlineToken, key: number) {
  switch (token.kind) {
    case "code":
      return (
        <code className="md-inline-code" key={key}>
          {token.value}
        </code>
      );
    case "strong":
      return <strong key={key}>{token.value}</strong>;
    case "emphasis":
      return <em key={key}>{token.value}</em>;
    case "link": {
      const href = safeHref(token.href);
      if (!href) {
        return <Fragment key={key}>{token.value}</Fragment>;
      }

      return (
        <a key={key} href={href} target="_blank" rel="noreferrer noopener">
          {token.value}
        </a>
      );
    }
    default:
      return <Fragment key={key}>{token.value}</Fragment>;
  }
}

/** Only web links are clickable; anything else stays plain text. */
function safeHref(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
