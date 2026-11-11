import type { ModelCapability, PowerTier, Session, SessionEvent, SessionState } from "@maia/contracts";
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
}

/** Persistence for the session lifecycle; the schema enforces one active row. */
export class SessionStore {
  constructor(private readonly database: DatabaseConnection) {}

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
           (id, model_id, provider, state, runtime, container_image, gpu_name, gpu_ram_gb,
            hourly_rate_microusd, estimated_total_microusd, label, started_at, power_tier, capability)
         VALUES
           (@id, @modelId, 'vastai', @state, @runtime, @containerImage, @gpuName, @gpuRamGb,
            @hourlyRateMicroUsd, @estimatedTotalMicroUsd, @label, @startedAt, @powerTier, @capability)`
      )
      .run({
        id: input.id,
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

  transition(
    sessionId: string,
    state: SessionState,
    patch: { readyAt?: string; endedAt?: string; endReason?: Session["endReason"]; failureCode?: string } = {}
  ): void {
    this.database
      .prepare(
        `UPDATE sessions
            SET state = @state,
                ready_at = COALESCE(@readyAt, ready_at),
                ended_at = COALESCE(@endedAt, ended_at),
                end_reason = COALESCE(@endReason, end_reason),
                failure_code = COALESCE(@failureCode, failure_code)
          WHERE id = @id`
      )
      .run({
        id: sessionId,
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
          WHERE state IN ('estimated', 'provisioning', 'ready', 'active', 'ending')
          ORDER BY started_at DESC`
      )
      .all() as SessionRow[];

    return rows.map((row) => toSession(row, this.eventsFor(row.id)));
  }

  get(sessionId: string): Session | null {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
      | SessionRow
      | undefined;

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
          WHERE state IN ('ending', 'ended', 'cancelled', 'failed')
          ORDER BY started_at DESC`
      )
      .all() as SessionRow[];

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
    events
  };
}
