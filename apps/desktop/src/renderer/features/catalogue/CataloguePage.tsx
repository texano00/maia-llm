import { memo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { CatalogueModel, ModelArtifact, Session } from "@maia/contracts";
import { describeGatedAccess, huggingFaceModelUrl, isChatCapableModel, isGgufRepositoryName } from "@maia/contracts";
import { useWorkspace } from "../../shared/session/WorkspaceProvider";
import { useProviderHealth } from "../../shared/health/useProviderHealth";
import { openOnboarding } from "../onboarding/open";
import { formatParameters, formatContext, formatBytes, formatUsd } from "../../shared/format";
export function CataloguePage() {
  const { health } = useProviderHealth();
  const {
    models,
    stale,
    loadingCatalogue,
    snapshot,
    search,
    setSearch,
    sort,
    setSort,
    capability,
    setCapability,
    supportedOnly,
    setSupportedOnly,
    mode,
    setMode,
    useCases,
    reloadUseCases,
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
  const [gatedConsentModelId, setGatedConsentModelId] = useState<string | null>(null);

  /** A curated card resolves to one model; the estimate panel is where it lands. */
  const pickUseCase = async (modelId: string): Promise<void> => {
    await selectModel(modelId);
    setMode("advanced");
  };

  // Every model keeps its own estimate and its own start request, so a model that
  // is still loading never blocks a different one from being prepared.
  const estimate = selected ? (estimates[selected.model.id] ?? null) : null;
  // A text-generation model can still be a base model with no chat template:
  // vLLM boots it and then rejects every message with HTTP 400. It can also be a
  // diffusion pack with no config.json, which vLLM cannot load at all.
  const chatReady = selected
    ? selected.support?.supported !== false &&
      selected.runnable !== false &&
      selected.chatTemplate !== false &&
      isChatCapableModel(selected.model)
    : false;
  const access = selected ? describeGatedAccess(selected.model.gated) : null;
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
        Free and fully open: no account, no email, no data selling. You bring your own
        provider keys and pay them directly. Models come from the catalogue MaiaLLM
        publishes, so the list is the same everywhere and works offline from the last
        snapshot. Nothing is provisioned until you review and confirm the cost estimate.
      </p>      {health?.huggingface.state === "missing" ? (
        <div className="alert">
          <span>Add your Hugging Face token to download models.</span>
          <button type="button" className="ghost-button" onClick={() => openOnboarding("huggingface")}>
            Set up the key
          </button>
        </div>
      ) : null}
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
        {snapshot ? (
          <span className="pill" title={`Published ${snapshot.refreshedAt}`}>
            catalogue v{snapshot.version} · {formatSnapshotAge(snapshot.refreshedAt)}
          </span>
        ) : null}
        {sessions.length > 0 ? (
          <span className="pill pill-ok">{describeSessions(sessions)}</span>
        ) : null}
      </div>

      <div className="toolbar">
        <div className="mode-switch" role="group" aria-label="Catalogue mode">
          <button
            type="button"
            className={mode === "basic" ? "ghost-button active" : "ghost-button"}
            aria-pressed={mode === "basic"}
            onClick={() => setMode("basic")}
          >
            Basic
          </button>
          <button
            type="button"
            className={mode === "advanced" ? "ghost-button active" : "ghost-button"}
            aria-pressed={mode === "advanced"}
            onClick={() => setMode("advanced")}
          >
            Advanced
          </button>
        </div>
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
          <input
            type="checkbox"
            checked={supportedOnly}
            onChange={(event) => setSupportedOnly(event.target.checked)}
          />
          <span>Only models I can run</span>
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

      <div className="use-case-grid" hidden={mode !== "basic"}>
        {useCases.map((useCase) => (
          <article key={useCase.id} className="use-case-card">
            {useCase.imageUrl ? (
              <img className="use-case-image" src={useCase.imageUrl} alt="" loading="lazy" />
            ) : null}
            <h2>{useCase.title}</h2>
            <p>{useCase.description}</p>
            {useCase.modelId ? (
              <p className="muted">
                Runs <code>{useCase.modelName ?? useCase.modelId}</code>
              </p>
            ) : (
              <p className="pill pill-warning">{useCase.reason ?? "No runnable model yet"}</p>
            )}
            <button
              type="button"
              disabled={!useCase.modelId}
              onClick={() => void pickUseCase(useCase.modelId as string)}
            >
              {useCase.modelId ? "Review and start" : "Unavailable"}
            </button>
          </article>
        ))}
        {useCases.length === 0 ? (
          <p className="muted">
            No curated use cases yet.{" "}
            <button type="button" className="ghost-button" onClick={() => void reloadUseCases()}>
              Reload
            </button>{" "}
            or switch to Advanced to browse the whole catalogue.
          </p>
        ) : null}
      </div>

      <div className="catalogue-grid" hidden={mode !== "advanced"}>
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
                {access ? (
                  <div className="info-row">
                    <dt>Access</dt>
                    <dd>{access.label}</dd>
                  </div>
                ) : null}
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
                {selected.support?.engine ? (
                  <div className="info-row">
                    <dt>Engine</dt>
                    <dd>{describeEngine(selected.support.engine)}</dd>
                  </div>
                ) : null}
              </dl>

              {selected.support && !selected.support.supported ? (
                <p className="pill pill-warning" role="note">
                  Cannot run this model: {selected.support.reason ?? "no engine can serve it"}
                </p>
              ) : null}

              {access ? (
                <GatedAccessNotice modelId={selected.model.id} description={access.description} />
              ) : null}

              {selected.runnable === false ? (
                <p className="pill pill-warning" role="note">
                  vLLM cannot load this repository: it
                  {" "}
                  {selected.runnableProblem ?? "is not a transformers model"}
                </p>
              ) : null}

              {selected.chatTemplate === false ? (
                <p className="pill pill-warning" role="note">
                  {isGgufRepositoryName(selected.model.id)
                    ? "No chat template: neither this GGUF repository nor its base model declares one, so chat requests would be rejected (HTTP 400)"
                    : "No chat template: a base model cannot answer chat requests"}
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

              {/* Every session serves the OpenAI chat-completions API on
                  localhost, which is what IDE extensions and scripts talk to. */}
              <p className="muted">
                Speaks the OpenAI API: once it is running, any tool that accepts a custom base URL
                can use it (Chat Completions at <code>/v1</code>).
              </p>

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
                      : selected.support?.supported === false
                        ? "Cannot run this model"
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
                  {access ? (
                    <label className="gated-access-consent">
                      <input
                        type="checkbox"
                        checked={gatedConsentModelId === selected.model.id}
                        onChange={(event) =>
                          setGatedConsentModelId(event.target.checked ? selected.model.id : null)
                        }
                      />
                      <span>
                        I accepted this model’s terms on Hugging Face, my token has access, and I
                        approve running it on a remote GPU.
                      </span>
                    </label>
                  ) : null}
                  <button
                    type="button"
                    disabled={
                      starting ||
                      !chatReady ||
                      (access !== null && gatedConsentModelId !== selected.model.id)
                    }
                    onClick={() => {
                      navigate("/chat");
                      void startSession(
                        selected.model.id,
                        access !== null && gatedConsentModelId === selected.model.id
                      );
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
 * Gated repositories only download with a token that has access, and access is
 * granted to a Hugging Face account, not to the app. The notice puts the two
 * steps the user has to take — open the model page and sign in with the token's
 * account — next to the model, before any GPU is rented.
 */
function GatedAccessNotice({ modelId, description }: { modelId: string; description: string }) {
  return (
    <div className="gated-access-confirmation" role="note">
      <p>{description}</p>
      <p>
        <a href={huggingFaceModelUrl(modelId)} target="_blank" rel="noopener noreferrer">
          Open {modelId} on Hugging Face
        </a>
      </p>
      <p className="muted small">
        Sign in to Hugging Face with the same account as the token saved in{" "}
        <Link to="/settings">Settings → Hugging Face token</Link>, then accept the model’s terms or
        request access. Without a matching token the remote download fails.
      </p>
    </div>
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
  const access = describeGatedAccess(model.gated);
  // The list scrolls (overflow-y: auto), which clips absolutely positioned
  // children, so the bubble is fixed-positioned from the pill's viewport rect.
  const [tip, setTip] = useState<{ text: string; left: number; top: number } | null>(null);

  const showTip = (text: string, target: HTMLElement): void => {
    const rect = target.getBoundingClientRect();
    setTip({
      text,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 340)),
      top: rect.bottom + 6
    });
  };

  return (
    <li>
      <button
        type="button"
        className={selected ? "model-row selected" : "model-row"}
        onClick={() => void onSelect(model.id)}
      >
        <span className="model-name-row">
          <span className="model-name">{model.id}</span>
          {access ? (
            <span
              className="tooltip-source"
              aria-label={access.description}
              onMouseEnter={(event) => showTip(access.description, event.currentTarget)}
              onMouseLeave={() => setTip(null)}
            >
              <span className="pill pill-warning">{access.label}</span>
            </span>
          ) : null}
          {model.supported === false ? (
            <span
              className="tooltip-source"
              onMouseEnter={(event) =>
                showTip(
                  model.supportedReason ??
                    "No engine can serve this model, so it cannot be started.",
                  event.currentTarget
                )
              }
              onMouseLeave={() => setTip(null)}
            >
              <span className="pill pill-warning">unsupported</span>
            </span>
          ) : null}
          {model.engine ? (
            <span className="pill">{describeEngine(model.engine)}</span>
          ) : null}
          {isChatCapableModel(model) ? null : (
            <span
              className="tooltip-source"
              onMouseEnter={(event) =>
                showTip(
                  "This model's task is not text generation, so it cannot answer chat requests and cannot be started.",
                  event.currentTarget
                )
              }
              onMouseLeave={() => setTip(null)}
            >
              <span className="pill pill-warning">not a chat model</span>
            </span>
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
      {tip ? (
        <span className="tooltip-bubble" role="tooltip" style={{ left: tip.left, top: tip.top }}>
          {tip.text}
        </span>
      ) : null}
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

/** Which runtime serves the model, in the words the docs use. */
function describeEngine(engine: "vllm" | "llamacpp"): string {
  return engine === "vllm" ? "vLLM" : "llama.cpp";
}

/** "12 min old" — the snapshot's age is what says whether the list is current. */
function formatSnapshotAge(refreshedAt: string): string {
  const then = new Date(refreshedAt).getTime();
  if (Number.isNaN(then)) {
    return "age unknown";
  }

  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) {
    return "just refreshed";
  }
  if (minutes < 60) {
    return `${minutes} min old`;
  }

  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h old` : `${Math.round(hours / 24)} d old`;
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
