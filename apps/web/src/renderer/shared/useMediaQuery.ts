import { useEffect, useState } from "react";
import { PHONE_MAX_WIDTH } from "./layout";

/**
 * True while the viewport is in the phone tier.
 *
 * Layout is expressed in the stylesheet; a few behaviours need the same answer in
 * JavaScript (the chat history becomes a drawer there). `matchMedia` keeps that
 * answer in sync with rotation and with a resized window, which a one-off
 * `innerWidth` read would not.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }

    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const list = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener("change", onChange);

    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** The tier the chat layout switches on: same number the stylesheet uses. */
export function usePhoneLayout(): boolean {
  return useMediaQuery(`(max-width: ${PHONE_MAX_WIDTH}px)`);
}
