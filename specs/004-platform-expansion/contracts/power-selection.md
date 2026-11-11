# Contract: Catalogue power selection and speed projection

**Feature**: `004-platform-expansion` | **Version**: 1.0

## View contract

| Property | Contract |
|---|---|
| Trigger | Requesting a run from either catalogue mode (the action that today creates an estimate). |
| Presentation | Modal popup titled around the selected model; the existing estimate card is not shown until the popup is confirmed. |
| Control | Horizontal slider with exactly three labelled stops: Economy, Balanced, Performance. Opens on the tier last used in this installation, defaulting to Balanced. |
| Live values | On every tier change the popup shows: projected output tokens per second (label: "estimated"), hourly rate in USD, projected total for the expected session, and an explicit "estimate, not a guarantee" note. Values refresh within 100 ms of the change. |
| Disclosure | When the projection comes from coarse defaults rather than measured runs, the popup says so. |
| Confirm | Creates the estimate with the chosen tier and continues to the existing estimate review and explicit confirmation. No resource is rented before that confirmation. |
| Cancel | Closes the popup with no estimate and no rental; the catalogue selection is unchanged. |
| Keyboard | Slider is operable by keyboard (arrow keys move between stops); Escape cancels; Enter confirms. |

## `estimate.preview`

Pure read, no side effects, no provider call.

| Property | Contract |
|---|---|
| Request | `{ modelId: string; powerTier: "economy" \| "balanced" \| "performance" }` |
| Response | `{ powerTier, hourlyRateMicroUsd, projectedTotalMicroUsd, projectedTokensPerSecond, projectionSource: "measured" \| "default", sampleCount: number, simulated: boolean }` |
| Rules | `hourlyRateMicroUsd` and `projectedTotalMicroUsd` use the same estimator as `estimate.create` for the offer class the tier selects. `projectedTokensPerSecond > 0`. `sampleCount` counts local completed runs for that model and tier with a positive rate. |
| Errors | `NO_OFFER` when no offer matches the tier and the model's requirements; `VALIDATION_FAILED` for an unknown tier or model id. |

## `estimate.create` (changed)

| Property | Contract |
|---|---|
| Request | Existing payload plus `powerTier: "economy" \| "balanced" \| "performance"` (default `balanced` when omitted, for older callers). |
| Response | The existing `Estimate` plus `powerTier`, echoed unchanged. |
| Rules | The estimate is priced for the offer class of the requested tier. The confirmation screen names the tier. |

## `session.start` / `Session` (changed)

| Property | Contract |
|---|---|
| Behaviour | The session records the tier from the estimate it was started with and echoes `powerTier` on every session read. |
| Compatibility | Existing callers that omit a tier receive `balanced`. No existing field changes meaning. |

## Tier → offer class mapping

| Tier | Offer selection |
|---|---|
| `economy` | Cheapest offer that satisfies the model's VRAM and runtime requirements. |
| `balanced` | Offer with the lowest price among those at or above the user's reliability floor (default `0.95`). |
| `performance` | Highest-throughput offer at or above the highest reliability floor (default `0.98`); price is secondary. |

The mapping lives beside the existing offer ranking so the popup and the actual booking can never disagree.

## Privacy and cost rules preserved

- No provider call and no rental occurs before the existing confirmation.
- The tier never changes caps, budgets or teardown; it only selects the offer class and therefore the rate and projection.
- The projection is derived from local measurements only; no telemetry leaves the machine as part of this contract.
