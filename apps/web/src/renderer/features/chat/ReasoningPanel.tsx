import { useEffect, useState } from "react";
import { ReasoningText } from "./ReasoningText";
import { usePacedText } from "./usePacedText";

interface ReasoningPanelProps {
  text: string;
  streaming: boolean;
  /** "Student mode": open by default and revealed at a human reading pace. */
  studentMode: boolean;
  variant: "bubble" | "inline";
}

/**
 * The collapsible "thinking" block shared by the live bubble and stored messages.
 *
 * In student mode the text is paced: the raw stream is much faster than reading
 * speed, so the panel reveals it progressively instead of dumping a wall of text
 * that keeps scrolling away from the reader.
 */
export function ReasoningPanel({ text, streaming, studentMode, variant }: ReasoningPanelProps) {
  const [open, setOpen] = useState(studentMode || streaming);
  const paced = usePacedText(text, studentMode && open);
  const revealing = paced.length < text.length;

  useEffect(() => {
    if (studentMode) {
      setOpen(true);
    }
  }, [studentMode]);

  return (
    <details
      className={variant === "bubble" ? "bubble bubble-reasoning" : "bubble-reasoning-inline"}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{streaming ? "Thinking…" : "Reasoning"}</span>
        {studentMode ? <span className="reasoning-hint">student mode · paced</span> : null}
      </summary>
      <ReasoningText text={paced} streaming={streaming || revealing} />
    </details>
  );
}
