/** What pressing a key in the composer should do. */
export function composerAction(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): "send" | "newline" | "ignore" {
  if (input.key !== "Enter") {
    return "ignore";
  }

  // An input method still composing (Japanese, Chinese, Korean…) uses Enter to
  // commit the candidate; sending there would fire a half-written message.
  if (input.isComposing) {
    return "ignore";
  }

  return input.shiftKey ? "newline" : "send";
}

/** The copy button's label, including after a failed clipboard write. */
export function copyFeedback(ok: boolean): string {
  return ok ? "Copied" : "Select and copy";
}

/** Status text announced to assistive technology; never the streaming tokens. */
export function turnStatusText(kind: "started" | "finished" | "stopped" | "failed"): string {
  switch (kind) {
    case "started":
      return "The model is replying.";
    case "finished":
      return "The model finished replying.";
    case "stopped":
      return "The reply was stopped.";
    case "failed":
      return "The reply failed. You can retry it.";
  }
}

/** A short, readable disclosure for turns the model was not shown. */
export function omittedNotice(count: number): string | null {
  if (count <= 0) {
    return null;
  }

  return `${count} earlier message${count === 1 ? " was" : "s were"} not sent to the model because they did not fit its context window.`;
}
