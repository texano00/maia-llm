import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { AuthRequestCodeResult, AuthVerifyCodeResult } from "@maia/contracts";
import { useAuth } from "../../shared/auth/AuthProvider";
import { ThemeToggle } from "../../shared/theme/ThemeToggle";
import { TurnstileWidget } from "./TurnstileWidget";

type Step = "email" | "code";

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/;

/**
 * The one page for first entry and return (FR-001): the same form creates the
 * account and signs in afterwards, and there is no password anywhere.
 */
export function AccessPage() {
  const { config, refresh } = useAuth();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [cookieBlocked, setCookieBlocked] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const waitSeconds = Math.max(Math.ceil((waitUntil - now) / 1_000), 0);
  const captchaRequired = config?.captcha != null && Boolean(config.captcha.siteKey);
  const captchaMissing = captchaRequired && captchaToken === null;
  const onToken = useCallback((token: string | null) => setCaptchaToken(token), []);

  const deliveryNotice = useMemo(() => {
    if (!config) {
      return "The code may take a minute to arrive.";
    }

    return config.emailDelivery === "log"
      ? "Development mode: the code is printed in the server log, not emailed."
      : "The code may take a minute to arrive. Check the spam folder too.";
  }, [config]);

  async function sendCode(): Promise<void> {
    const address = email.trim();
    if (!EMAIL_PATTERN.test(address) || address.length > 254) {
      setError("Enter a valid email address.");
      return;
    }

    if (waitSeconds > 0) {
      return;
    }

    setBusy(true);
    setError(null);
    setCookieBlocked(false);

    const result = await window.maia?.invoke<AuthRequestCodeResult>("auth.requestCode", {
      email: address,
      ...(captchaToken ? { captchaToken } : {})
    });

    setBusy(false);

    if (result?.ok) {
      setStep("code");
      setCode("");
      setNotice(deliveryNotice);
      setWaitUntil(Date.now() + result.data.resendAfterSeconds * 1_000);
      return;
    }

    if (result?.error.code === "RATE_LIMITED") {
      const seconds = Number(result.error.details?.retryAfterSeconds ?? 60);
      setWaitUntil(Date.now() + Math.max(seconds, 1) * 1_000);
    }

    setError(result?.error.message ?? "The request could not be sent. Try again.");
    setCaptchaToken(null);
  }

  function submitEmail(event: FormEvent): void {
    event.preventDefault();
    void sendCode();
  }

  async function submitCode(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the six-digit code.");
      return;
    }

    setBusy(true);
    setError(null);

    const result = await window.maia?.invoke<AuthVerifyCodeResult>("auth.verifyCode", {
      email: email.trim(),
      code
    });

    setBusy(false);

    if (result?.ok) {
      const usable = await refresh();
      if (!usable) {
        // The server accepted the code but the browser dropped the cookie.
        setCookieBlocked(true);
        setError(
          "Signed in, but this browser did not keep the session cookie. Allow cookies for this site and ask for a new code."
        );
      }
      return;
    }

    const remaining = result?.error.details?.attemptsRemaining;
    setError(
      result
        ? `${result.error.message}${typeof remaining === "number" ? ` ${remaining} attempt${remaining === 1 ? "" : "s"} left.` : ""}`
        : "The code could not be checked. Try again."
    );

    if (result?.error.details?.requiresNewCode === true) {
      setNotice("That code is used up. Ask for a new one.");
    }
  }

  return (
    <div className="access-shell">
      <div className="access-card">
        <div className="access-header">
          <p className="eyebrow">Maia LLM</p>
          <ThemeToggle compact />
        </div>
        <h1>{step === "email" ? "Enter your email" : "Enter your code"}</h1>
        <p className="lede">
          {step === "email"
            ? "We send a one-time code. Entering it creates your account the first time and signs you in afterwards — no password."
            : `We sent a six-digit code to ${email.trim()}.`}
        </p>

        {step === "email" ? (
          <form className="access-form" onSubmit={submitEmail}>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                disabled={busy}
              />
            </label>

            {captchaRequired ? <TurnstileWidget siteKey={config!.captcha!.siteKey} onToken={onToken} /> : null}

            <button type="submit" disabled={busy || captchaMissing || waitSeconds > 0}>
              {busy
                ? "Sending…"
                : waitSeconds > 0
                  ? `Try again in ${waitSeconds}s`
                  : "Send me a code"}
            </button>
          </form>
        ) : (
          <form className="access-form" onSubmit={(event) => void submitCode(event)}>
            <label className="field">
              <span>Six-digit code</span>
              <input
                type="text"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                placeholder="123456"
                disabled={busy}
                autoFocus
              />
            </label>

            <button type="submit" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Enter Maia LLM"}
            </button>

            <div className="access-actions">
              <button
                type="button"
                className="link-button"
                onClick={() => void sendCode()}
                disabled={busy || waitSeconds > 0 || cookieBlocked}
              >
                {waitSeconds > 0 ? `Send another code in ${waitSeconds}s` : "Send another code"}
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setStep("email");
                  setCode("");
                  setError(null);
                  setNotice(null);
                }}
                disabled={busy}
              >
                Use a different address
              </button>
            </div>
          </form>
        )}

        {notice ? <p className="field-hint">{notice}</p> : null}
        {error ? <p className="field-error">{error}</p> : null}

        <p className="access-fineprint">
          The address identifies the conversations, images and provider keys you save. It is not a
          profile, and deleting it removes all of it.
        </p>
      </div>
    </div>
  );
}
