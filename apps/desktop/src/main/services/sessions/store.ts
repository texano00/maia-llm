import type { Session, SessionState } from "@maia/contracts";
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
  }): void {
    this.database
      .prepare(
        `INSERT INTO sessions
           (id, model_id, provider, state, runtime, container_image, gpu_name, gpu_ram_gb,
            hourly_rate_microusd, estimated_total_microusd, label, started_at)
         VALUES
           (@id, @modelId, 'vastai', @state, @runtime, @containerImage, @gpuName, @gpuRamGb,
            @hourlyRateMicroUsd, @estimatedTotalMicroUsd, @label, @startedAt)`
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
        startedAt: input.startedAt
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

    return rows.map(toSession);
  }

  get(sessionId: string): Session | null {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
      | SessionRow
      | undefined;

    return row ? toSession(row) : null;
  }
}

function toSession(row: SessionRow): Session {
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
    simulated: row.label.startsWith("maia:mock:")
  };
}
