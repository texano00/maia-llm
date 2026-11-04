import { useEffect, useRef, useState } from "react";

/** Reveal cadence: one tick every 50 ms, i.e. 20 updates per second. */
const TICK_MS = 50;
/**
 * Characters per tick are derived from the backlog, which gives an exponential
 * catch-up: a short lag is revealed at reading speed (~20 chars/s), a long one
 * speeds up (~1 000 chars/s) so the reader never falls minutes behind the model.
 */
const CATCH_UP_DIVISOR = 18;

/**
 * Reveals text at a pace a human can follow.
 *
 * Used by "student mode": the model streams far faster than anyone reads its
 * reasoning, so the panel would otherwise fill instantly and the interesting part
 * (how the answer is being derived) is impossible to follow.
 */
export function usePacedText(text: string, animate: boolean): string {
  const [visible, setVisible] = useState(() => (animate ? 0 : text.length));
  const targetRef = useRef(text.length);
  targetRef.current = text.length;

  useEffect(() => {
    if (!animate) {
      setVisible(text.length);
      return;
    }

    setVisible((current) => (current > text.length ? text.length : current));
  }, [animate, text.length]);

  useEffect(() => {
    if (!animate) {
      return;
    }

    const timer = setInterval(() => {
      setVisible((current) => {
        const target = targetRef.current;
        if (current >= target) {
          return current;
        }

        const backlog = target - current;
        const step = Math.max(1, Math.floor(backlog / CATCH_UP_DIVISOR));
        return Math.min(target, current + step);
      });
    }, TICK_MS);

    return () => clearInterval(timer);
  }, [animate]);

  return text.slice(0, Math.min(visible, text.length));
}
