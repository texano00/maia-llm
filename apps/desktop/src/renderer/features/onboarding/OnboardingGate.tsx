import { useCallback, useEffect, useState } from "react";
import type { AppSettings, CredentialStatus, CredentialTestResult } from "@maia/contracts";
import { firstIncompleteStep, ONBOARDING_STEPS, shouldShowOnboarding, type OnboardingStepKey } from "./state";
import { ONBOARDING_EVENT } from "./open";

const STEP_COPY: Record<Exclude<OnboardingStepKey, "finish">, { body: string; placeholder: string }> = {
  huggingface: {
    body: "Used only to download the open-weight models you choose. Create it at huggingface.co → Settings → Access Tokens.",
    placeholder: "hf_..."
  },
  vastai: {
    body: "Your only form of payment: vast.ai rents the GPU you pick, and Maia LLM charges nothing. Create a key at vast.ai → Account → API Keys.",
    placeholder: "vast.ai API key"
  }
};

/**
 * First-run guide. Dismissible at any step, never blocking, and re-openable from
 * the screens where a missing key stops the user.
 */
export function OnboardingGate() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [step, setStep] = useState<OnboardingStepKey | null>(null);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (forced?: OnboardingStepKey) => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    const [settingsResult, statusResult] = await Promise.all([
      bridge.invoke<AppSettings>("settings.get"),
      bridge.invoke<CredentialStatus>("settings.credentials.status")
    ]);

    if (!settingsResult.ok || !statusResult.ok) {
      return;
    }

    setSettings(settingsResult.data);
    setStatus(statusResult.data);
    if (forced) {
      setStep(forced);
    } else if (shouldShowOnboarding(settingsResult.data, statusResult.data)) {
      setStep(firstIncompleteStep(statusResult.data));
    }
  }, []);

  useEffect(() => {
    void load();
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<{ step?: OnboardingStepKey }>).detail;
      void load(detail?.step);
    };
    window.addEventListener(ONBOARDING_EVENT, onOpen);
    return () => window.removeEventListener(ONBOARDING_EVENT, onOpen);
  }, [load]);

  const close = useCallback(() => {
    setStep(null);
    setSecret("");
    setError(null);
  }, []);

  const dismiss = useCallback(async () => {
    const bridge = window.maia;
    await bridge?.invoke("settings.update", { onboardingDismissedAt: new Date().toISOString() });
    close();
  }, [close]);

  const finish = useCallback(async () => {
    const bridge = window.maia;
    await bridge?.invoke("settings.update", { onboardingCompleted: true });
    close();
  }, [close]);

  async function submit(): Promise<void> {
    const bridge = window.maia;
    const value = secret.trim();
    if (!bridge || step === null || step === "finish" || value.length === 0) {
      return;
    }

    setBusy(true);
    setError(null);

    const saved = await bridge.invoke("settings.credentials.set", { provider: step, secret: value });
    if (!saved.ok) {
      setBusy(false);
      setError(saved.error.message);
      return;
    }

    const tested = await bridge.invoke<CredentialTestResult>("settings.credentials.test", { provider: step });
    const message = tested.ok ? tested.data.message : tested.error.message;
    const ok = tested.ok && tested.data.ok;

    if (!ok) {
      // A rejected key must not be left behind.
      await bridge.invoke("settings.credentials.clear", { provider: step });
      setBusy(false);
      setError(message);
      return;
    }

    const statusResult = await bridge.invoke<CredentialStatus>("settings.credentials.status");
    setSecret("");
    setBusy(false);

    if (statusResult.ok) {
      setStatus(statusResult.data);
      setStep(firstIncompleteStep(statusResult.data));
    }
  }

  if (!settings || !status || step === null) {
    return null;
  }

  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="onboarding-card">
        <header>
          <h2 id="onboarding-title">Set up Maia LLM</h2>
          <button type="button" className="ghost-button" onClick={() => void dismiss()}>
            Skip for now
          </button>
        </header>

        <ol className="onboarding-steps">
          {ONBOARDING_STEPS.map((entry) => (
            <li key={entry.key} className={entry.key === step ? "onboarding-step active" : "onboarding-step"}>
              {entry.title}
            </li>
          ))}
        </ol>

        {step === "finish" ? (
          <>
            <p>
              Both keys are working. Maia LLM is free and fully open: you pay the providers directly for
              the models and compute you use, and nothing else. Your conversations stay on this machine.
            </p>
            <button type="button" onClick={() => void finish()}>
              Start using Maia LLM
            </button>
          </>
        ) : (
          <>
            <p>{STEP_COPY[step].body}</p>
            <label className="field">
              <span>{step === "huggingface" ? "Hugging Face token" : "vast.ai API key"}</span>
              <input
                type="password"
                value={secret}
                placeholder={STEP_COPY[step].placeholder}
                autoComplete="off"
                onChange={(event) => setSecret(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void submit();
                  }
                }}
              />
            </label>
            {error ? (
              <p className="field-error" role="alert">
                {error}
              </p>
            ) : null}
            <button type="button" disabled={busy || secret.trim().length === 0} onClick={() => void submit()}>
              {busy ? "Checking…" : "Save and verify"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
