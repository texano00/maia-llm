import { useEffect } from "react";

/**
 * Publishes the height the on-screen keyboard covers as `--keyboard-inset`.
 *
 * iOS Safari does not shrink the layout viewport when the keyboard opens, so a
 * bottom-anchored composer would sit behind it. The visual viewport is the only
 * portable signal; where it is unsupported the variable stays at zero and nothing
 * changes. The listener is passive and writes one custom property, so it costs a
 * style recalculation per keyboard frame rather than a React render.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!viewport) {
      return;
    }

    const root = document.documentElement;
    const apply = (): void => {
      const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      // A keyboard animates: rounding avoids a cascade of sub-pixel values.
      root.style.setProperty("--keyboard-inset", `${Math.round(covered)}px`);
    };

    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);

    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      root.style.removeProperty("--keyboard-inset");
    };
  }, []);
}
