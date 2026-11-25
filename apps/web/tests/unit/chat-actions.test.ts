import { describe, expect, it } from "vitest";
import {
  composerAction,
  copyFeedback,
  omittedNotice,
  turnStatusText
} from "../../src/renderer/features/chat/chat-actions";

describe("composer conventions", () => {
  it("sends on Enter and inserts a newline on Shift+Enter", () => {
    expect(composerAction({ key: "Enter", shiftKey: false, isComposing: false })).toBe("send");
    expect(composerAction({ key: "Enter", shiftKey: true, isComposing: false })).toBe("newline");
  });

  it("never sends while an input method is composing", () => {
    expect(composerAction({ key: "Enter", shiftKey: false, isComposing: true })).toBe("ignore");
  });

  it("ignores other keys", () => {
    expect(composerAction({ key: "a", shiftKey: false, isComposing: false })).toBe("ignore");
  });
});

describe("chat feedback helpers", () => {
  it("tells the truth when the clipboard is blocked", () => {
    expect(copyFeedback(true)).toBe("Copied");
    expect(copyFeedback(false)).toBe("Select and copy");
  });

  it("announces a state, never the streaming text", () => {
    expect(turnStatusText("started")).toMatch(/replying/);
    expect(turnStatusText("stopped")).toMatch(/stopped/);
    expect(turnStatusText("failed")).toMatch(/retry/);
  });

  it("discloses omitted history only when something was dropped", () => {
    expect(omittedNotice(0)).toBeNull();
    expect(omittedNotice(1)).toMatch(/1 earlier message was not sent/);
    expect(omittedNotice(3)).toMatch(/3 earlier messages were not sent/);
  });
});
