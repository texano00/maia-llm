export const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type CaptchaVerdict = { ok: true } | { ok: false; reason: "rejected" | "unavailable" };

/**
 * Captcha port. `siteKey` is `null` when the flow runs without a captcha, which
 * is only acceptable outside production (see `createCaptchaVerifier`).
 */
export interface CaptchaVerifier {
  readonly siteKey: string | null;
  verify(token: string | undefined, sourceAddress: string): Promise<CaptchaVerdict>;
}

export interface CaptchaOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

/**
 * Cloudflare Turnstile. Two failures are kept apart on purpose:
 * a rejected token is the visitor's problem (`rejected`), while an unreachable
 * endpoint must not send email either, but is retryable (`unavailable`).
 */
export function createCaptchaVerifier(options: CaptchaOptions = {}): CaptchaVerifier {
  const env = options.env ?? process.env;
  const logger = options.logger ?? {
    warn: (message: string) => console.warn(`[web] ${message}`)
  };

  const secret = env.MAIA_TURNSTILE_SECRET_KEY?.trim();
  const siteKey = env.MAIA_TURNSTILE_SITE_KEY?.trim();
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!secret) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "MAIA_TURNSTILE_SECRET_KEY is required in production: the access page must not run without a captcha."
      );
    }

    if (siteKey) {
      throw new Error("MAIA_TURNSTILE_SITE_KEY is set but MAIA_TURNSTILE_SECRET_KEY is missing");
    }

    logger.warn("captcha is disabled (no MAIA_TURNSTILE_SECRET_KEY outside production)");
    return {
      siteKey: null,
      async verify() {
        return { ok: true };
      }
    };
  }

  if (!siteKey) {
    throw new Error("MAIA_TURNSTILE_SITE_KEY is required when MAIA_TURNSTILE_SECRET_KEY is set");
  }

  return {
    siteKey,
    async verify(token, sourceAddress) {
      if (!token) {
        return { ok: false, reason: "rejected" };
      }

      let response: Response;
      try {
        const body = new URLSearchParams({ secret, response: token });
        if (sourceAddress) {
          body.set("remoteip", sourceAddress);
        }

        response = await fetchImpl(TURNSTILE_VERIFY_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body
        });
      } catch {
        return { ok: false, reason: "unavailable" };
      }

      if (!response.ok) {
        return { ok: false, reason: "unavailable" };
      }

      try {
        const payload = (await response.json()) as { success?: boolean };
        return payload.success === true ? { ok: true } : { ok: false, reason: "rejected" };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    }
  };
}
