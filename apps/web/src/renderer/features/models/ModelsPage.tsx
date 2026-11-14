import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatUsd } from "../../shared/format";
import { DEFAULT_STATUS_FILTER, filterRuns, emptyStateFor, STATUS_FILTERS, type StatusFilter } from "./filter";
import { describeRun } from "./run-details";
import { isChatEligible, type VisibleStatus } from "./status";
import { ExternalAccessPanel } from "./ExternalAccessPanel";
import { mergeAcknowledged, failedRunIds } from "./indicator";
import { useUiPreferences } from "../../shared/preferences/useUiPreferences";
import { updatePreferences } from "../../shared/preferences/store";
import { useModelRuns } from "./useModelRuns";
import { useProviderHealth } from "../../shared/health/useProviderHealth";
import { openOnboarding } from "../onboarding/open";

const STATUS_LABELS: Record<VisibleStatus, string> = {
  initializing: "Initializing",
  running: "Running",
  terminated: "Terminated"
};

/**
 * Model runs requested from this installation. The shared workspace poller keeps
 * active runs current; `session.history` supplies ended runs from local storage.
 * Chat remains the place to talk to a running model.
 */
export function ModelsPage() {
  const { health } = useProviderHealth();
  const { runs, historyError, reloadHistory } = useModelRuns();
  const { acknowledgedFailureIds } = useUiPreferences();
  const [filter, setFilter] = useState<StatusFilter>(DEFAULT_STATUS_FILTER);
  const [now, setNow] = useState(() => Date.now());
  const visibleRuns = filterRuns(runs, filter);
  const empty = emptyStateFor(filter);

  // Opening Models acknowledges failures: the navigation indicator goes back to
  // orange and the bell stops repeating them.
  useEffect(() => {
    const merged = mergeAcknowledged(acknowledgedFailureIds, failedRunIds(runs));
    if (merged.length !== acknowledgedFailureIds.length) {
      updatePreferences({ acknowledgedFailureIds: merged });
    }
  }, [acknowledgedFailureIds, runs]);

  // The elapsed/cost meter only matters while a run is in flight; a one-second
  // tick mirrors the chat meter without touching the history query.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className="models-page">
      <header className="models-head">
        <div>
          <h1>Models</h1>
          <p className="muted small">
            Every model run requested from this app. Chat is where you use a running model.
          </p>
        </div>
        {/* Filter lives in component state: a fresh visit always starts on Running. */}
        <label className="inline-field models-filter">
          <span>Status</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value as StatusFilter)}>
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      {health?.vastai.state === "missing" ? (
        <div className="alert">
          <span>Add your vast.ai key to rent a GPU and run models.</span>
          <button type="button" className="ghost-button" onClick={() => openOnboarding("vastai")}>
            Set up the key
          </button>
        </div>
      ) : null}

      {historyError ? (
        <div className="alert" role="alert">
          <span>Could not load model run history: {historyError}</span>
          <button type="button" className="ghost-button" onClick={() => void reloadHistory()}>
            Retry
          </button>
        </div>
      ) : null}

      {visibleRuns.length === 0 ? (
        <div className="models-empty">
          <h2>{empty.title}</h2>
          <p className="muted small">{empty.detail}</p>
        </div>
      ) : (
        <ul className="model-run-list">
          {visibleRuns.map((run) => {
            const details = describeRun(run, { now });
            const latestEvent = run.events.length > 0 ? run.events[run.events.length - 1] : null;
            const latestError = [...run.events].reverse().find((event) => event.level === "error") ?? null;

            return (
              <li key={run.id} className={`model-run model-run-${details.visibleStatus}`}>
                <div className="model-run-head">
                  <div>
                    <h2>{run.modelId}</h2>
                    <p className="muted small">
                      Run <code>{run.id.slice(0, 8)}</code> · started{" "}
                      <time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleString()}</time>
                    </p>
                  </div>
                  <span className={`pill models-status models-status-${details.visibleStatus}`}>
                    {STATUS_LABELS[details.visibleStatus]}
                  </span>
                </div>

                <dl className="model-run-facts">
                  <div>
                    <dt>Runtime</dt>
                    <dd>
                      {run.runtime}
                      {run.instanceId ? ` · instance ${run.instanceId}` : ""}
                    </dd>
                  </div>
                  <div>
                    <dt>GPU</dt>
                    <dd>
                      {run.gpuName
                        ? `${run.gpuName}${run.gpuRamGb ? ` · ${run.gpuRamGb} GB` : ""}`
                        : "unavailable"}
                    </dd>
                  </div>
                  <div>
                    <dt>Rate</dt>
                    <dd>{formatUsd(run.hourlyRateMicroUsd)}/h</dd>
                  </div>
                  <div>
                    <dt>Estimate</dt>
                    <dd>{formatUsd(run.estimatedTotalMicroUsd)}</dd>
                  </div>
                  <div>
                    <dt>{details.visibleStatus === "terminated" ? "Duration" : "Elapsed"}</dt>
                    <dd>{details.elapsed}</dd>
                  </div>
                  <div>
                    <dt>Accrued</dt>
                    <dd>{details.accrued}</dd>
                  </div>
                  {details.endTime ? (
                    <div>
                      <dt>Ended</dt>
                      <dd>
                        <time dateTime={details.endTime}>
                          {new Date(details.endTime).toLocaleString()}
                        </time>
                      </dd>
                    </div>
                  ) : null}
                  {details.endReasonLabel ? (
                    <div>
                      <dt>Reason</dt>
                      <dd>{details.endReasonLabel}</dd>
                    </div>
                  ) : null}
                </dl>

                {details.endDetailsPending ? (
                  <p className="muted small">
                    Teardown in progress. Final duration and cost are recorded when the run ends; the
                    model is no longer available in Chat.
                  </p>
                ) : null}

                {details.visibleStatus === "terminated" && latestError ? (
                  <p className="small">Last error: {latestError.message}</p>
                ) : null}

                {details.visibleStatus === "initializing" ? (
                  <div className="model-run-progress">
                    <p className="small">
                      Startup progress:{" "}
                      {latestEvent
                        ? `${latestEvent.message} (${new Date(latestEvent.at).toLocaleTimeString()})`
                        : "waiting for the first lifecycle event"}
                    </p>
                    <p className="muted small">
                      Runtime and cost details are pending until the model reports ready.
                    </p>
                  </div>
                ) : null}

                {details.accruedMicroUsd !== null ? <p className="muted small">{details.note}</p> : null}

                {run.state === "active" ? <ExternalAccessPanel sessionId={run.id} /> : null}

                {isChatEligible(run.state) ? (
                  <div className="model-run-actions">
                    <Link className="ghost-button" to="/chat">
                      Open in Chat
                    </Link>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
