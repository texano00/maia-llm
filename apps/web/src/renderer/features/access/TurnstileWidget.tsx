import { useEffect, useRef } from "react";

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      theme?: "light" | "dark" | "auto";
      callback(token: string): void;
      "expired-callback"(): void;
      "error-callback"(): void;
    }
  ): string;
  remove(widgetId: string): void;
  reset(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * Renders the captcha once per page and reports the token upward. The script is
 * loaded here rather than in `index.html` so it never runs in the signed-in app.
 */
export function TurnstileWidget({
  siteKey,
  onToken
}: {
  siteKey: string;
  onToken(token: string | null): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const latestToken = useRef(onToken);
  latestToken.current = onToken;

  useEffect(() => {
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | null = null;

    const render = (): void => {
      if (cancelled || !container.current || !window.turnstile || widgetId.current !== null) {
        return;
      }

      widgetId.current = window.turnstile.render(container.current, {
        sitekey: siteKey,
        theme: "dark",
        callback: (token) => latestToken.current(token),
        "expired-callback": () => latestToken.current(null),
        "error-callback": () => latestToken.current(null)
      });
    };

    if (window.turnstile) {
      render();
    } else {
      if (!document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
        const script = document.createElement("script");
        script.src = SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }

      poll = setInterval(() => {
        if (window.turnstile) {
          if (poll) {
            clearInterval(poll);
            poll = null;
          }
          render();
        }
      }, 200);
    }

    return () => {
      cancelled = true;
      if (poll) {
        clearInterval(poll);
      }

      if (widgetId.current !== null && window.turnstile) {
        try {
          window.turnstile.remove(widgetId.current);
        } catch {
          // The widget may already be gone with the container.
        }
      }

      widgetId.current = null;
    };
  }, [siteKey]);

  return <div className="access-captcha" ref={container} />;
}
