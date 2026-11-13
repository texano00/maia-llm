import { Fragment, memo, type ReactElement } from "react";
import { parseInline, splitReasoning, type ReasoningBlock } from "./reasoning-format";
import { CodeBlock } from "./CodeBlock";

interface ReasoningTextProps {
  text: string;
  /** Shows a caret while the model is still thinking. */
  streaming?: boolean;
}

/**
 * Renders a reasoning stream so it can be followed: paragraphs, bullet lists and
 * fenced code in a monospace panel with a language tag and a copy button.
 */
export const ReasoningText = memo(function ReasoningText({
  text,
  streaming = false
}: ReasoningTextProps) {
  const blocks = splitReasoning(text);

  return (
    <div className="reasoning-body">
      {blocks.map((block, index) => (
        <Fragment key={index}>{renderBlock(block)}</Fragment>
      ))}
      {streaming ? <span className="reasoning-caret" aria-hidden="true" /> : null}
    </div>
  );
});

function renderBlock(block: ReasoningBlock): ReactElement {
  if (block.kind === "code") {
    return <CodeBlock code={block.code} language={block.language} />;
  }

  if (block.kind === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    return (
      <Tag className="reasoning-list">
        {block.items.map((item, index) => (
          <li key={index}>{renderInline(item)}</li>
        ))}
      </Tag>
    );
  }

  return <p className="reasoning-paragraph">{renderInline(block.text)}</p>;
}

function renderInline(text: string): ReactElement[] {
  return parseInline(text).map((token, index) => {
    if (token.kind === "code") {
      return (
        <code key={index} className="reasoning-inline-code">
          {token.value}
        </code>
      );
    }
    if (token.kind === "strong") {
      return <strong key={index}>{token.value}</strong>;
    }

    return <Fragment key={index}>{token.value}</Fragment>;
  });
}
