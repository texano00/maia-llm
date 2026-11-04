import { memo } from "react";
import { useNavigate } from "react-router-dom";
import type { CatalogueModel, ModelArtifact, Session } from "@maia/contracts";
import { isChatCapableModel } from "@maia/contracts";
import { useWorkspace } from "../../shared/session/WorkspaceProvider";
import { formatParameters, formatContext, formatBytes, formatUsd } from "../../shared/format";
export function CataloguePage() {
  const {
    models,
    stale,
    loadingCatalogue,
    search,
    setSearch,
    sort,
    setSort,
    capability,
    setCapability,
    refreshCatalogue,
    selectModel,
    selected,
    estimates,
    preparing,
    prepareEstimate,
    startSession,
    startingIds,
    sessions,
    error,
    clearError
  } = useWorkspace();
  const navigate = useNavigate();

  // Every model keeps its own estimate and its own start request, so a model that
  // is still loading never blocks a different one from being prepared.
  const estimate = selected ? (estimates[selected.model.id] ?? null) : null;
  // A text-generation model can still be a base model with no chat template:
  // vLLM boots it and then rejects every message with HTTP 400. It can also be a
  // diffusion pack with no config.json, which vLLM cannot load at all.
  const chatReady = selected
    ? isChatCapableModel(selected.model) &&
      selected.chatTemplate !== false &&
      selected.runnable !== false
    : false;
  const starting = selected ? startingIds.includes(selected.model.id) : false;
  const existingSession = selected
    ? (sessions.find(
        (session) =>
          session.modelId === selected.model.id &&
          (session.state === "provisioning" ||
            session.state === "ready" ||
            session.state === "active")
      ) ?? null)
    : null;

  return (
    <section>
      <p className="eyebrow">Catalogue</p>
      <h1>Pick a model to run</h1>
      <p className="lede">
        Models come from the local snapshot of the Hugging Face catalogue. Nothing is provisioned
        until you review and confirm the cost estimate.
      </p>

      {error ? (
        <div className="alert" role="alert">
          <span>{error}</span>
          <button type="button" className="ghost-button" onClick={clearError}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="toolbar">
        <input
          className="search-input"
          type="search"
          placeholder="Search by name or author"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button
          type="button"
          className="ghost-button"
          onClick={() => void refreshCatalogue()}
          disabled={loadingCatalogue}
        >
          {loadingCatalogue ? "Refreshing…" : "Refresh"}
        </button>
        {stale ? <span className="pill pill-warning">Offline snapshot</span> : null}
        {sessions.length > 0 ? (
          <span className="pill pill-ok">{describeSessions(sessions)}</span>
        ) : null}
      </div>

      <div className="toolbar">
        <label className="inline-field">
          <span>Order by</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
            <option value="downloads">Most downloads</option>
            <option value="last-modified">Newest</option>
            <option value="likes">Most liked</option>
            <option value="context-desc">Largest context</option>
            <option value="parameters-asc">Smallest model</option>
            <option value="parameters-desc">Largest model</option>
          </select>
        </label>
        <label className="inline-field">
          <span>Feature</span>
          <select value={capability} onChange={(event) => setCapability(event.target.value)}>
            <option value="">Any feature</option>
            <option value="tools">Tool use</option>
            <option value="reasoning">Reasoning</option>
            <option value="vision">Vision</option>
            <option value="code">Code</option>
            <option value="long-context">Long context</option>
            <option value="multilingual">Multilingual</option>
          </select>
        </label>
      </div>

      <div className="catalogue-grid">
        <ul className="model-list">
          {models.length === 0 && !loadingCatalogue ? (
            <li className="muted">No models match this search.</li>
          ) : null}
          {models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              selected={selected?.model.id === model.id}
              onSelect={selectModel}
            />
          ))}
        </ul>

        <div className="panel">
          {selected ? (
            <>
              <h2>{selected.model.name}</h2>
              <dl className="info-list">
                <div className="info-row">
                  <dt>License</dt>
                  <dd>{selected.model.license ?? "unknown"}</dd>
                </div>
                <div className="info-row">
                  <dt>Parameters</dt>
                  <dd>
                    {selected.model.parameterCount
                      ? formatParameters(selected.model.parameterCount)
                      : "unknown"}
                  </dd>
                </div>
                <div className="info-row">
                  <dt>Context</dt>
                  <dd>
                    {selected.model.contextWindow
                      ? formatContext(selected.model.contextWindow)
                      : "unknown"}
                  </dd>
                </div>
                <div className="info-row">
                  <dt>Downloads</dt>
                  <dd>{selected.model.downloads.toLocaleString()}</dd>
                </div>
                <div className="info-row">
                  <dt>Artifacts</dt>
                  <dd>{selected.artifacts.length}</dd>
                </div>
                <div className="info-row">
                  <dt>Weights</dt>
                  <dd>{describeWeights(selected.artifacts)}</dd>
                </div>
              </dl>

              {selected.runnable === false ? (
                <p className="pill pill-warning" role="note">
                  vLLM cannot load this repository: it
                  {" "}
                  {selected.runnableProblem ?? "is not a transformers model"}
                </p>
              ) : null}

              {selected.chatTemplate === false ? (
                <p className="pill pill-warning" role="note">
                  No chat template: a base model cannot answer chat requests
                </p>
              ) : null}

              {selected.artifacts.length > 0 ? (
                <ul className="artifact-list">
                  {selected.artifacts.slice(0, 4).map((artifact) => (
                    <li key={artifact.id}>
                      <code>{artifact.path}</code>
                      <span className="muted">{formatBytes(artifact.sizeBytes)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {existingSession ? (
                <div className="session-state">
                  <p className={existingSession.state === "active" ? "pill pill-ok" : "pill pill-warning"}>
                    {describeSessionState(existingSession)}
                  </p>
                  <button type="button" onClick={() => navigate("/chat")}>
                    Open chat
                  </button>
                </div>
              ) : !estimate ? (
                <button
                  type="button"
                  disabled={preparing || !chatReady}
                  onClick={() => void prepareEstimate(selected.model.id)}
                >
                  {preparing
                    ? "Estimating…"
                    : chatReady
                      ? "Estimate a session"
                      : selected.runnable === false
                        ? "Cannot run this model"
                        : "Not a chat model"}
                </button>
              ) : (
                <div className="estimate-card">
                  <h3>Before we rent anything</h3>
                  <dl className="info-list">
                    <div className="info-row">
                      <dt>GPU</dt>
                      <dd>
                        {estimate.gpuName} · {estimate.gpuRamGb} GB
                      </dd>
                    </div>
                    <div className="info-row">
                      <dt>Hourly rate</dt>
                      <dd>{formatUsd(estimate.hourlyRateMicroUsd)}/h</dd>
                    </div>
                    <div className="info-row">
                      <dt>Minimum charge</dt>
                      <dd>
                        {estimate.minimumMinutes} min · {formatUsd(estimate.rangeMicroUsd.low)}
                      </dd>
                    </div>
                    <div className="info-row">
                      <dt>Expected {estimate.expectedMinutes} min</dt>
                      <dd>{formatUsd(estimate.projectedTotalMicroUsd)}</dd>
                    </div>
                    <div className="info-row">
                      <dt>Range</dt>
                      <dd>
                        {formatUsd(estimate.rangeMicroUsd.low)} –{" "}
                        {formatUsd(estimate.rangeMicroUsd.high)}
                      </dd>
                    </div>
                    <div className="info-row">
                      <dt>Wait</dt>
                      <dd>
                        {estimate.waitMinutes.low}–{estimate.waitMinutes.high} min
                      </dd>
                    </div>
                  </dl>
                  {estimate.simulated ? <span className="pill pill-warning">Simulated GPU</span> : null}
                  <ul className="muted small">
                    {estimate.assumptions.map((assumption) => (
                      <li key={assumption}>{assumption}</li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    disabled={starting || !chatReady}
                    onClick={() => {
                      navigate("/chat");
                      void startSession(selected.model.id);
                    }}
                  >
                    {starting
                      ? "Booking a GPU…"
                      : chatReady
                        ? "Confirm and start session"
                        : selected.runnable === false
                          ? "Cannot run this model"
                          : "Not a chat model"}
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="muted">Select a model to see its license, artifacts, and requirements.</p>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * One row of the catalogue. Memoised: the list holds up to a hundred entries and
 * the shared workspace provider updates on every poll.
 */
const ModelRow = memo(function ModelRow({
  model,
  selected,
  onSelect
}: {
  model: CatalogueModel;
  selected: boolean;
  onSelect(modelId: string): Promise<void>;
}) {
  return (
    <li>
      <button
        type="button"
        className={selected ? "model-row selected" : "model-row"}
        onClick={() => void onSelect(model.id)}
      >
        <span className="model-name-row">
          <span className="model-name">{model.id}</span>
          {model.gated !== "none" ? <span className="pill pill-warning">gated</span> : null}
          {isChatCapableModel(model) ? null : (
            <span className="pill pill-warning">not a chat model</span>
          )}
        </span>
        <span className="model-meta">
          {model.pipelineTag ?? "unknown task"}
          {model.parameterCount ? ` · ${formatParameters(model.parameterCount)}` : ""}
          {model.contextWindow ? ` · ${formatContext(model.contextWindow)} ctx` : ""}
        </span>
        <span className="model-stats">
          {model.lastModifiedAt
            ? `Updated ${formatRelative(model.lastModifiedAt)}`
            : "Update date unknown"}
          <span className="stat">⤓ {formatCount(model.downloads)}</span>
          <span className="stat">♥ {formatCount(model.likes)}</span>
          {model.license ? <span className="stat">{model.license}</span> : null}
        </span>
      </button>
    </li>
  );
});

/** "2 running · 1 provisioning" — models boot independently, so say which is which. */
function describeSessions(sessions: Session[]): string {
  const provisioning = sessions.filter(
    (session) => session.state === "provisioning" || session.state === "ready"
  ).length;
  const running = sessions.length - provisioning;
  const parts: string[] = [];

  if (running > 0) {
    parts.push(`${running} running`);
  }
  if (provisioning > 0) {
    parts.push(`${provisioning} provisioning`);
  }

  return parts.join(" · ") || `${sessions.length} active`;
}

function describeSessionState(session: Session): string {
  switch (session.state) {
    case "provisioning":
      return "This model is provisioning — chat opens as soon as it is ready";
    case "ready":
      return "This model is almost ready";
    case "active":
      return "This model is running";
    default:
      return `Session ${session.state}`;
  }
}

/**
 * How this repository will be served. GGUF is supported through vLLM's GGUF
 * plugin (experimental upstream), so the panel states the fact instead of
 * warning that the runtime "may not load it".
 */
function describeWeights(artifacts: readonly ModelArtifact[]): string {
  const safetensors = artifacts.some((artifact) => artifact.format === "safetensors");
  if (safetensors) {
    return "safetensors";
  }

  const gguf = artifacts.filter((artifact) => artifact.format === "gguf");
  if (gguf.length === 0) {
    return "unknown";
  }

  const quants = [...new Set(gguf.map((artifact) => artifact.quantization).filter(Boolean))];
  return quants.length > 0 ? `GGUF · ${quants.slice(0, 3).join(", ")}` : "GGUF";
}

function formatCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(value);
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "unknown";
  }

  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) {
    return "today";
  }
  if (days === 1) {
    return "yesterday";
  }
  if (days < 30) {
    return `${days} days ago`;
  }
  if (days < 365) {
    return `${Math.floor(days / 30)} months ago`;
  }
  return `${Math.floor(days / 365)} years ago`;
}
