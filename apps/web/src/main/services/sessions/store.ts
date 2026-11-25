import type {
  ModelCapability,
  PowerTier,
  ReleaseReason,
  RestartState,
  RuntimeConfig,
  RuntimeValues,
  Session,
  SessionEvent,
  SessionState
} from "@maia/contracts";
import { randomUUID } from "node:crypto";
import type { DatabaseConnection } from "../../storage/db";

interface SessionRow {
  id: string;
  model_id: string;
  state: SessionState;
  runtime: "vllm" | "llamacpp";
  label: string;
  gpu_name: string | null;
  gpu_ram_gb: number | null;
  hourly_rate_microusd: number;
  estimated_total_microusd: number;
  started_at: string;
  ready_at: string | null;
  ended_at: string | null;
  end_reason: Session["endReason"];
  instance_id: number | null;
  power_tier: PowerTier;
  capability: ModelCapability;
  boot_phase: string | null;
  boot_percent: number | null;
  boot_progress_at: string | null;
  boot_ceiling_at: string | null;
  endpoint_host: string | null;
  endpoint_port: number | null;
  release_reason: ReleaseReason | null;
  release_phase: string | null;
  release_elapsed_ms: number | null;
  runtime_config_json: string | null;
  restart_json: string | null;
}

/** One restart attempt as the run's history records it. */
export interface RestartRecord {
  id: string;
  sessionId: string;
  requestedAt: string;
  previous: RuntimeValues;
  target: RuntimeValues;
  outcome: "started" | "succeeded" | "failed" | "refused";
  reason: string | null;
  completedAt: string | null;
}

/** The subset of `RuntimeConfig` this store persists; the rest is derived. */
export interface StoredRuntimeConfig {
  current: RuntimeValues;
  defaults: RuntimeValues;
  contextWindowMax: number | null;
  contextWindowMaxSource: "model" | "product";
}

/** Persistence for the session lifecycle; the schema enforces one active row. */
export class SessionStore {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly accountId: string
  ) {}

  insert(input: {
    id: string;
    modelId: string;
    state: SessionState;
    runtime: Session["runtime"];
    label: string;
    gpuName: string;
    gpuRamGb: number;
    hourlyRateMicroUsd: number;
    estimatedTotalMicroUsd: number;
    startedAt: string;
    containerImage: string;
    powerTier?: PowerTier;
    capability?: ModelCapability;
  }): void {
    this.database
      .prepare(
        `INSERT INTO sessions
           (id, account_id, model_id, provider, state, runtime, container_image, gpu_name, gpu_ram_gb,
            hourly_rate_microusd, estimated_total_microusd, label, started_at, power_tier, capability)
         VALUES
           (@id, @accountId, @modelId, 'vastai', @state, @runtime, @containerImage, @gpuName, @gpuRamGb,
            @hourlyRateMicroUsd, @estimatedTotalMicroUsd, @label, @startedAt, @powerTier, @capability)`
      )
      .run({
        id: input.id,
        accountId: this.accountId,
        modelId: input.modelId,
        state: input.state,
        runtime: input.runtime,
        containerImage: input.containerImage,
        gpuName: input.gpuName,
        gpuRamGb: input.gpuRamGb,
        hourlyRateMicroUsd: input.hourlyRateMicroUsd,
        estimatedTotalMicroUsd: input.estimatedTotalMicroUsd,
        label: input.label,
        startedAt: input.startedAt,
        powerTier: input.powerTier ?? "balanced",
        capability: input.capability ?? "text"
      });
  }

  setInstance(sessionId: string, instanceId: number, offerId: number | null): void {
    this.database
      .prepare("UPDATE sessions SET instance_id = ?, offer_id = ? WHERE id = ?")
      .run(instanceId, offerId, sessionId);
  }

  /**
   * What the boot is doing right now. Throttled by the caller: the column is for
   * the person watching, not an audit trail.
   */
  recordBoot(
    sessionId: string,
    input: {
      phase: string;
      percent: number | null;
      progressAt: string;
      ceilingAt: string | null;
    }
  ): void {
    this.database
      .prepare(
        `UPDATE sessions
            SET boot_phase = @phase,
                boot_percent = @percent,
                boot_progress_at = @progressAt,
                boot_ceiling_at = COALESCE(@ceilingAt, boot_ceiling_at)
          WHERE id = @id AND account_id = @accountId`
      )
      .run({
        id: sessionId,
        accountId: this.accountId,
        phase: input.phase,
        percent: input.percent,
        progressAt: input.progressAt,
        ceilingAt: input.ceilingAt
      });
  }

  /** The address the host published, kept until the run is released. */
  recordEndpoint(sessionId: string, host: string, port: number): void {
    this.database
      .prepare(
        "UPDATE sessions SET endpoint_host = ?, endpoint_port = ? WHERE id = ? AND account_id = ?"
      )
      .run(host, port, sessionId, this.accountId);
  }

  /** Clears the boot phase once the run serves (or stops). */
  clearBoot(sessionId: string): void {
    this.database
      .prepare(
        "UPDATE sessions SET boot_phase = NULL, boot_percent = NULL WHERE id = ? AND account_id = ?"
      )
      .run(sessionId, this.accountId);
  }

  /** Clears the address when the machine goes away, so no dead link survives. */
  clearEndpoint(sessionId: string): void {
    this.database
      .prepare(
        "UPDATE sessions SET endpoint_host = NULL, endpoint_port = NULL WHERE id = ? AND account_id = ?"
      )
      .run(sessionId, this.accountId);
  }

  /** Why a run ended, and how far the boot got. Required on every terminal path. */
  recordRelease(
    sessionId: string,
    input: { reason: ReleaseReason; phase: string | null; elapsedMs: number }
  ): void {
    this.database
      .prepare(
        `UPDATE sessions
            SET release_reason = @reason,
                release_phase = @phase,
                release_elapsed_ms = @elapsedMs,
                boot_phase = NULL,
                boot_percent = NULL
          WHERE id = @id AND account_id = @accountId`
      )
      .run({
        id: sessionId,
        accountId: this.accountId,
        reason: input.reason,
        phase: input.phase,
        elapsedMs: Math.max(0, Math.round(input.elapsedMs))
      });
  }

  /**
   * The values this run starts with. Written on the first edit and after a
   * restart succeeds; never before, so the UI cannot claim a value early.
   */
  recordRuntimeConfig(sessionId: string, config: StoredRuntimeConfig): void {
    this.database
      .prepare(
        "UPDATE sessions SET runtime_config_json = ? WHERE id = ? AND account_id = ?"
      )
      .run(JSON.stringify(config), sessionId, this.accountId);
  }

  /** Marks a restart as in flight; cleared when it succeeds or fails. */
  beginRestart(sessionId: string, restart: RestartState): void {
    this.database
      .prepare("UPDATE sessions SET restart_json = ? WHERE id = ? AND account_id = ?")
      .run(JSON.stringify(restart), sessionId, this.accountId);
  }

  clearRestart(sessionId: string): void {
    this.database
      .prepare("UPDATE sessions SET restart_json = NULL WHERE id = ? AND account_id = ?")
      .run(sessionId, this.accountId);
  }

  /** Opens an audit row; the same row is completed when the restart settles. */
  recordRestart(input: {
    sessionId: string;
    previous: RuntimeValues;
    target: RuntimeValues;
    outcome: "started" | "succeeded" | "failed" | "refused";
    reason?: string | null;
    requestedAt?: string;
    completedAt?: string | null;
  }): string {
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO session_restarts
           (id, session_id, account_id, requested_at, previous_json, target_json, outcome, reason, completed_at)
         VALUES (@id, @sessionId, @accountId, @requestedAt, @previous, @target, @outcome, @reason, @completedAt)`
      )
      .run({
        id,
        sessionId: input.sessionId,
        accountId: this.accountId,
        requestedAt: input.requestedAt ?? new Date().toISOString(),
        previous: JSON.stringify(input.previous),
        target: JSON.stringify(input.target),
        outcome: input.outcome,
        reason: input.reason ?? null,
        completedAt: input.completedAt ?? null
      });

    return id;
  }

  completeRestart(
    restartId: string,
    outcome: "succeeded" | "failed",
    reason: string | null = null
  ): void {
    this.database
      .prepare(
        "UPDATE session_restarts SET outcome = ?, reason = ?, completed_at = ? WHERE id = ? AND account_id = ?"
      )
      .run(outcome, reason, new Date().toISOString(), restartId, this.accountId);
  }

  /** Newest first; the run card shows the last few and the full list on demand. */
  getRestartHistory(sessionId: string): RestartRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, session_id, requested_at, previous_json, target_json, outcome, reason, completed_at
           FROM session_restarts
          WHERE session_id = ? AND account_id = ?
          ORDER BY requested_at DESC`
      )
      .all(sessionId, this.accountId) as Array<{
      id: string;
      session_id: string;
      requested_at: string;
      previous_json: string;
      target_json: string;
      outcome: RestartRecord["outcome"];
      reason: string | null;
      completed_at: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      requestedAt: row.requested_at,
      previous: parseRuntimeValues(row.previous_json),
      target: parseRuntimeValues(row.target_json),
      outcome: row.outcome,
      reason: row.reason,
      completedAt: row.completed_at
    }));
  }

  transition(
    sessionId: string,
    state: SessionState,
    patch: { readyAt?: string; endedAt?: string; endReason?: Session["endReason"]; failureCode?: string } = {}
  ): void {    this.database
      .prepare(
        `UPDATE sessions
            SET state = @state,
                ready_at = COALESCE(@readyAt, ready_at),
                ended_at = COALESCE(@endedAt, ended_at),
                end_reason = COALESCE(@endReason, end_reason),
                failure_code = COALESCE(@failureCode, failure_code)
          WHERE id = @id AND account_id = @accountId`
      )
      .run({
        id: sessionId,
        accountId: this.accountId,
        state,
        readyAt: patch.readyAt ?? null,
        endedAt: patch.endedAt ?? null,
        endReason: patch.endReason ?? null,
        failureCode: patch.failureCode ?? null
      });
  }

  getActive(): Session[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM sessions
          WHERE account_id = ? AND state IN ('estimated', 'provisioning', 'ready', 'active', 'ending')
          ORDER BY started_at DESC`
      )
      .all(this.accountId) as SessionRow[];

    return rows.map((row) => toSession(row, this.eventsFor(row.id)));
  }

  get(sessionId: string): Session | null {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE id = ? AND account_id = ?")
      .get(sessionId, this.accountId) as SessionRow | undefined;

    return row ? toSession(row, this.eventsFor(sessionId)) : null;
  }

  /** Written exactly once per terminated run; later writes replace nothing. */
  recordMetric(input: {
    sessionId: string;
    modelId: string;
    powerTier: PowerTier;
    outputTokens: number | null;
    generationMs: number | null;
    tokensPerSecond: number | null;
    outcome: "completed" | "failed" | "cancelled" | "capped" | "idle";
    recordedAt: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO session_metrics
           (session_id, model_id, power_tier, output_tokens, generation_ms, tokens_per_second, outcome, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO NOTHING`
      )
      .run(
        input.sessionId,
        input.modelId,
        input.powerTier,
        input.outputTokens,
        input.generationMs,
        input.tokensPerSecond,
        input.outcome,
        input.recordedAt
      );
  }

  metricFor(sessionId: string): {
    outputTokens: number | null;
    generationMs: number | null;
    tokensPerSecond: number | null;
    outcome: "completed" | "failed" | "cancelled" | "capped" | "idle";
  } | null {
    const row = this.database
      .prepare(
        "SELECT output_tokens, generation_ms, tokens_per_second, outcome FROM session_metrics WHERE session_id = ?"
      )
      .get(sessionId) as
      | {
          output_tokens: number | null;
          generation_ms: number | null;
          tokens_per_second: number | null;
          outcome: "completed" | "failed" | "cancelled" | "capped" | "idle";
        }
      | undefined;

    return row
      ? {
          outputTokens: row.output_tokens,
          generationMs: row.generation_ms,
          tokensPerSecond: row.tokens_per_second,
          outcome: row.outcome
        }
      : null;
  }

  /** Most recent measured output rates for a model, newest first. */
  recentSpeeds(modelId: string, limit = 20): number[] {    const rows = this.database
      .prepare(
        `SELECT tokens_per_second FROM session_metrics
          WHERE model_id = ? AND tokens_per_second IS NOT NULL
          ORDER BY recorded_at DESC LIMIT ?`
      )
      .all(modelId, limit) as Array<{ tokens_per_second: number }>;

    return rows.map((row) => row.tokens_per_second);
  }

  /**
   * Terminal and teardown rows for the Models view. Ordered newest first and
   * deliberately unbounded: a run stays in history until its session history is
   * deleted, so there is no age or count cap here.
   */
  getTerminated(): Session[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM sessions
          WHERE account_id = ? AND state IN ('ending', 'ended', 'cancelled', 'failed')
          ORDER BY started_at DESC`
      )
      .all(this.accountId) as SessionRow[];

    return rows.map((row) => toSession(row, this.eventsFor(row.id)));
  }

  /** Provisioning log entries, oldest first (bounded to the last 60). */
  eventsFor(sessionId: string): SessionEvent[] {
    const rows = this.database
      .prepare(
        "SELECT payload_json, created_at FROM session_events WHERE session_id = ? ORDER BY created_at ASC LIMIT 60"
      )
      .all(sessionId) as Array<{ payload_json: string; created_at: string }>;

    return rows.map((row) => {
      try {
        const parsed = JSON.parse(row.payload_json) as { level?: SessionEvent["level"]; message?: string };
        return {
          at: row.created_at,
          level: parsed.level ?? "info",
          message: parsed.message ?? ""
        };
      } catch {
        return { at: row.created_at, level: "info" as const, message: row.payload_json };
      }
    });
  }

  appendEvent(sessionId: string, level: SessionEvent["level"], message: string, at = new Date()): void {
    this.database
      .prepare(
        "INSERT INTO session_events (id, session_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(randomUUID(), sessionId, "lifecycle", JSON.stringify({ level, message }), at.toISOString());
  }
}

function toSession(row: SessionRow, events: SessionEvent[] = []): Session {
  return {
    id: row.id,
    modelId: row.model_id,
    state: row.state,
    runtime: row.runtime,
    label: row.label,
    gpuName: row.gpu_name,
    gpuRamGb: row.gpu_ram_gb,
    hourlyRateMicroUsd: row.hourly_rate_microusd,
    estimatedTotalMicroUsd: row.estimated_total_microusd,
    startedAt: row.started_at,
    readyAt: row.ready_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    instanceId: row.instance_id,
    powerTier: row.power_tier,
    capability: row.capability,
    simulated: row.label.startsWith("maia:mock:"),
    events,
    boot:
      row.boot_phase === null
        ? null
        : {
            text: row.boot_phase,
            percent: row.boot_percent,
            observedAt: row.boot_progress_at ?? row.started_at,
            source: "container" as const
          },
    endpoint:
      row.endpoint_host === null || row.endpoint_port === null
        ? null
        : { host: row.endpoint_host, port: row.endpoint_port, serving: false },
    release:
      row.release_reason === null
        ? null
        : {
            reason: row.release_reason,
            phase: row.release_phase,
            elapsedMs: row.release_elapsed_ms ?? 0
          },
    runtimeConfig: parseStoredConfig(row.runtime_config_json),
    restart: parseRestart(row.restart_json)
  };
}

function parseStoredConfig(raw: string | null): RuntimeConfig | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredRuntimeConfig>;
    if (!parsed.current || !parsed.defaults) {
      return null;
    }

    return {
      current: parsed.current,
      defaults: parsed.defaults,
      contextWindowMax: parsed.contextWindowMax ?? null,
      contextWindowMaxSource: parsed.contextWindowMaxSource ?? "product",
      concurrencyMax: parsed.current.maxConcurrentRequests,
      estimatedMaxContext: parsed.current.contextWindow,
      fits: true,
      restart: null
    };
  } catch {
    return null;
  }
}

function parseRestart(raw: string | null): RestartState | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as RestartState;
  } catch {
    return null;
  }
}

function parseRuntimeValues(raw: string): RuntimeValues {
  try {
    return JSON.parse(raw) as RuntimeValues;
  } catch {
    return { contextWindow: 4096, maxConcurrentRequests: 1 };
  }
}
