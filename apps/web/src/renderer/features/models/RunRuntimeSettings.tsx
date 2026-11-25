import { useCallback, useEffect, useState } from "react";
import type { Estimate, RestartResult, RuntimeConfig, RuntimeValues } from "@maia/contracts";
import { formatUsd } from "../../shared/format";
import {
  describeCardEstimate,
  describeContextCeiling,
  initialValues,
  restartConfirmation,
  validateRuntimeValues
} from "./run-runtime";

interface Props {
  sessionId: string;
  /** Called when the run's state changed enough that the page should reload. */
  onChanged?: () => void;
}

/**
 * The values this run serves with, and the one action that changes them. The
 * apply path is a restart on the same rented machine: the panel never claims a
 * new value before the server actually starts with it.
 */
export function RunRuntimeSettings({ sessionId, onChanged }: Props) {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [values, setValues] = useState<RuntimeValues | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Estimate | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    const result = await bridge.invoke<RuntimeConfig | null>("session.runtimeConfig", { sessionId });
    if (!result.ok) {
      return;
    }

    setConfig(result.data);
    if (result.data && values === null) {
      setValues(initialValues(result.data));
    }
  }, [sessionId, values]);

  useEffect(() => {
    void load();
  }, [load]);

  // A restart changes the run's state on the server; follow it until it settles.
  useEffect(() => {
    if (!config?.restart) {
      return;
    }

    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      void load();
    }, 5_000);

    return () => clearInterval(timer);
  }, [config?.restart, load]);

  if (!config || !values) {
    return null;
  }

  const restarting = config.restart !== null;
  const problem = validateRuntimeValues(values, config);
  const note = describeCardEstimate(config);

  const apply = async (): Promise<void> => {
    const bridge = window.maia;
    if (!bridge || problem || restarting) {
      return;
    }

    if (!window.confirm(restartConfirmation(values, config))) {
      return;
    }

    setBusy(true);
    setError(null);
    setFresh(null);

    const result = await bridge.invoke<RestartResult>("session.restart", {
      sessionId,
      confirmRestart: true,
      values
    });

    setBusy(false);

    if (!result.ok) {
      setError(result.error.message);
      return;
    }

    if (result.data.status === "fresh_run_required") {
      setFresh(result.data.estimate);
      setError(result.data.reason);
      onChanged?.();
      await load();
      return;
    }

    if (result.data.status === "failed") {
      setError(result.data.reason);
    }

    setValues({ ...result.data.config.current });
    onChanged?.();
    await load();
  };

  const startFresh = async (): Promise<void> => {
    const bridge = window.maia;
    if (!bridge || !fresh) {
      return;
    }

    if (
      !window.confirm(
        `Start a new run for ${fresh.modelId} at ${formatUsd(fresh.hourlyRateMicroUsd)}/h, projected ${formatUsd(fresh.projectedTotalMicroUsd)}? A new machine is rented and the estimate above is what you are confirming.`
      )
    ) {
      return;
    }

    setBusy(true);
    const result = await bridge.invoke("session.start", {
      estimateId: fresh.id,
      confirmEstimate: true
    });
    setBusy(false);

    if (!result.ok) {
      setError(result.error.message);
      return;
    }

    setFresh(null);
    onChanged?.();
  };

  return (
    <details className="runtime-settings" open={restarting || error ? true : undefined}>
      <summary>Model settings</summary>

      {restarting ? (
        <p className="runtime-restarting" role="status">
          Restarting with {config.restart?.target.contextWindow.toLocaleString()} tokens…
          Chat is unavailable until the model serves again.
        </p>
      ) : null}

      <div className="runtime-field">
        <label htmlFor={`context-${sessionId}`}>Context window</label>
        <input
          id={`context-${sessionId}`}
          type="number"
          inputMode="numeric"
          min={4096}
          max={config.contextWindowMax ?? 32_768}
          step={1024}
          value={values.contextWindow}
          disabled={busy || restarting}
          onChange={(event) =>
            setValues((current) =>
              current ? { ...current, contextWindow: Number(event.target.value) } : current
            )
          }
        />
        <p className="muted small">Per request, {describeContextCeiling(config)}.</p>
      </div>

      <div className="runtime-field">
        <label htmlFor={`concurrency-${sessionId}`}>Requests at once</label>
        <select
          id={`concurrency-${sessionId}`}
          value={values.maxConcurrentRequests}
          disabled={busy || restarting}
          onChange={(event) =>
            setValues((current) =>
              current
                ? { ...current, maxConcurrentRequests: Number(event.target.value) }
                : current
            )
          }
        >
          {Array.from({ length: Math.max(1, Math.min(8, config.concurrencyMax)) }, (_, index) => index + 1).map(
            (option) => (
              <option key={option} value={option}>
                {option}
              </option>
            )
          )}
        </select>
        <p className="muted small">More requests share the same GPU memory.</p>
      </div>

      <p className={config.fits ? "muted small" : "runtime-risk"}>{note}</p>
      {problem ? <p className="muted small">{problem}</p> : null}
      {error ? (
        <p className="runtime-risk" role="alert">
          {error}
        </p>
      ) : null}

      {fresh ? (
        <div className="update-actions">
          <span className="muted small">
            {formatUsd(fresh.hourlyRateMicroUsd)}/h · projected{" "}
            {formatUsd(fresh.projectedTotalMicroUsd)}
          </span>
          <button type="button" className="ghost-button" disabled={busy} onClick={() => void startFresh()}>
            Start a fresh run
          </button>
        </div>
      ) : null}

      <div className="update-actions">
        <button
          type="button"
          disabled={busy || restarting || problem !== null}
          onClick={() => void apply()}
        >
          {busy ? "Restarting…" : "Apply and restart"}
        </button>
      </div>
    </details>
  );
}
