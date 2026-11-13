import { useEffect, useState } from "react";
import type { EstimatePreview, PowerTier } from "@maia/contracts";
import { formatUsd } from "../../shared/format";

export const POWER_TIER_OPTIONS: ReadonlyArray<{ value: PowerTier; label: string; hint: string }> = [
  { value: "economy", label: "Economy", hint: "Cheapest GPU; slower output" },
  { value: "balanced", label: "Balanced", hint: "Reliable GPU at a fair price" },
  { value: "performance", label: "Performance", hint: "Most reliable GPU; fastest output" }
];

export const DEFAULT_POWER_TIER: PowerTier = "balanced";

interface PowerPickerProps {
  modelId: string;
  onCancel: () => void;
  onConfirm: (tier: PowerTier) => void;
}

/**
 * Asks how much power to rent before any estimate exists. The projection is an
 * estimate, never a guarantee, and the cost rules are the same ones the
 * confirmation screen uses.
 */
export function PowerPicker({ modelId, onCancel, onConfirm }: PowerPickerProps) {
  const [tier, setTier] = useState<PowerTier>(DEFAULT_POWER_TIER);
  const [preview, setPreview] = useState<EstimatePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const index = POWER_TIER_OPTIONS.findIndex((option) => option.value === tier);

  useEffect(() => {
    const bridge = window.maia;
    if (!bridge) {
      return;
    }

    let cancelled = false;
    setError(null);
    const timer = setTimeout(() => {
      void bridge.invoke<EstimatePreview>("estimate.preview", { modelId, powerTier: tier }).then((result) => {
        if (cancelled) {
          return;
        }
        if (result.ok) {
          setPreview(result.data);
        } else {
          setPreview(null);
          setError(result.error.message);
        }
      });
    }, 100);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [modelId, tier]);

  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-labelledby="power-title">
      <div className="onboarding-card power-picker">
        <header>
          <h2 id="power-title">How much power?</h2>
          <button type="button" className="ghost-button" onClick={onCancel}>
            Cancel
          </button>
        </header>

        <p className="muted small">
          {modelId} — the estimate updates as you move. Nothing is rented until you confirm the price.
        </p>

        <label className="field">
          <span>
            Power: {POWER_TIER_OPTIONS[index]?.label} — {POWER_TIER_OPTIONS[index]?.hint}
          </span>
          <input
            type="range"
            min={0}
            max={POWER_TIER_OPTIONS.length - 1}
            step={1}
            value={index}
            aria-valuetext={POWER_TIER_OPTIONS[index]?.label}
            onChange={(event) => {
              const option = POWER_TIER_OPTIONS[Number(event.target.value)];
              if (option) {
                setTier(option.value);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" && index > 0) {
                setTier(POWER_TIER_OPTIONS[index - 1]!.value);
              }
              if (event.key === "ArrowRight" && index < POWER_TIER_OPTIONS.length - 1) {
                setTier(POWER_TIER_OPTIONS[index + 1]!.value);
              }
            }}
          />
        </label>

        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : preview ? (
          <dl className="model-run-facts">
            <div>
              <dt>Estimated speed</dt>
              <dd>
                {preview.projectedTokensPerSecond.toFixed(1)} tokens/s
                <span className="muted small">
                  {preview.projectionSource === "measured"
                    ? ` · from ${preview.sampleCount} measured runs`
                    : " · coarse default"}
                </span>
              </dd>
            </div>
            <div>
              <dt>Hourly rate</dt>
              <dd>{formatUsd(preview.hourlyRateMicroUsd)}/h</dd>
            </div>
            <div>
              <dt>Expected 30 min</dt>
              <dd>{formatUsd(preview.projectedTotalMicroUsd)}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted small">Checking available GPUs…</p>
        )}

        <p className="muted small">An estimate, not a guarantee.</p>

        <div className="update-actions">
          <button type="button" disabled={preview === null} onClick={() => onConfirm(tier)}>
            Continue to the price
          </button>
          <button type="button" className="ghost-button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
