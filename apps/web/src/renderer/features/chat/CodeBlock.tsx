import { memo, useMemo, useState } from "react";
import { writeClipboard } from "../../shared/clipboard";
import { highlightCode, languageLabel, type HighlightToken } from "./highlight";

interface CodeBlockProps {
  code: string;
  language: string | null;
}

/**
 * A fenced snippet with its language and a copy button.
 *
 * Every model answer contains commands or diffs that end up pasted somewhere, so
 * copying is the primary action: the button is always visible, confirms with
 * "Copied" and falls back to the legacy selection trick when the asynchronous
 * clipboard API is unavailable.
 */
export const CodeBlock = memo(function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const lines = useMemo(() => highlightCode(code, language), [code, language]);
  const label = languageLabel(language);

  async function copy(): Promise<void> {
    const ok = await writeClipboard(code);
    if (!ok) {
      return;
    }

    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <figure className="code-block">
      <figcaption>
        <span className="code-language">{label}</span>
        <button
          type="button"
          className={copied ? "code-copy copied" : "code-copy"}
          onClick={() => void copy()}
          aria-label={copied ? "Copied" : `Copy ${label} snippet`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      <pre className={`code-body language-${label}`} tabIndex={0}>
        <code>
          {lines.map((line, index) => (
            <span className="code-line" key={index}>
              {line.map((token, tokenIndex) => renderToken(token, tokenIndex))}
              {index < lines.length - 1 ? "\n" : null}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
});

function renderToken(token: HighlightToken, key: number) {
  if (token.type === "plain") {
    return <span key={key}>{token.text}</span>;
  }

  return (
    <span key={key} className={`tok-${token.type}`}>
      {token.text}
    </span>
  );
}
