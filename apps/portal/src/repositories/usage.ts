import type { SqlDatabase } from "../db/database.js";
import type { UsageSample } from "../usage-schema.js";

export interface UsageSampleRecord extends UsageSample {
  observedAddress: string;
  receivedAt: string;
}

export interface UsageSummaryRow {
  modelId: string;
  capability: string;
  samples: number;
  medianTokensPerSecond: number | null;
  lastSeenAt: string;
}

export interface UsageInstallationRow {
  installationId: string;
  appVersion: string;
  os: string;
  osVersion: string;
  arch: string;
  deviceClass: string;
  samples: number;
  firstSeenAt: string;
  lastSeenAt: string;
  optedOut: boolean;
}

export interface UsageRepository {
  append(sample: UsageSampleRecord): Promise<void>;
  setOptedOut(installationId: string, optedOut: boolean, updatedAt: string): Promise<void>;
  isOptedOut(installationId: string): Promise<boolean>;
  listInstallations(limit: number): Promise<UsageInstallationRow[]>;
  summariseModels(installationId: string): Promise<UsageSummaryRow[]>;
  countSamples(): Promise<number>;
}

export function createUsageRepository(db: SqlDatabase): UsageRepository {
  return {
    async append(sample) {
      await db.execute(
        `INSERT INTO usage_samples
           (installation_id, app_version, os, os_version, arch, device_class, model_id,
            capability, output_tokens, generation_ms, tokens_per_second, outcome,
            occurred_at, observed_address, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sample.installationId,
          sample.appVersion,
          sample.os,
          sample.osVersion,
          sample.arch,
          sample.deviceClass,
          sample.modelId,
          sample.capability,
          sample.outputTokens,
          sample.generationMs,
          sample.tokensPerSecond,
          sample.outcome,
          sample.occurredAt,
          sample.observedAddress,
          sample.receivedAt,
        ],
      );

      await db.execute(
        `INSERT INTO usage_installations (installation_id, opted_out, updated_at)
         VALUES (?, 0, ?)
         ON CONFLICT (installation_id) DO UPDATE SET updated_at = excluded.updated_at`,
        [sample.installationId, sample.receivedAt],
      );
    },

    async setOptedOut(installationId, optedOut, updatedAt) {
      await db.execute(
        `INSERT INTO usage_installations (installation_id, opted_out, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (installation_id) DO UPDATE
           SET opted_out = excluded.opted_out, updated_at = excluded.updated_at`,
        [installationId, optedOut ? 1 : 0, updatedAt],
      );
    },

    async isOptedOut(installationId) {
      const rows = await db.query<{ opted_out: number }>(
        "SELECT opted_out FROM usage_installations WHERE installation_id = ?",
        [installationId],
      );
      return (rows[0]?.opted_out ?? 0) === 1;
    },

    async listInstallations(limit) {
      const rows = await db.query<{
        installation_id: string;
        app_version: string;
        os: string;
        os_version: string;
        arch: string;
        device_class: string;
        samples: number;
        first_seen_at: string;
        last_seen_at: string;
        opted_out: number | null;
      }>(
        `SELECT installation_id, MAX(app_version) AS app_version, MAX(os) AS os,
                MAX(os_version) AS os_version, MAX(arch) AS arch,
                MAX(device_class) AS device_class, COUNT(*) AS samples,
                MIN(received_at) AS first_seen_at, MAX(received_at) AS last_seen_at,
                MAX(i.opted_out) AS opted_out
           FROM usage_samples s
           LEFT JOIN usage_installations i ON i.installation_id = s.installation_id
          GROUP BY installation_id
          ORDER BY last_seen_at DESC
          LIMIT ?`,
        [limit],
      );

      return rows.map((row) => ({
        installationId: row.installation_id,
        appVersion: row.app_version,
        os: row.os,
        osVersion: row.os_version,
        arch: row.arch,
        deviceClass: row.device_class,
        samples: Number(row.samples),
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        optedOut: (row.opted_out ?? 0) === 1,
      }));
    },

    async summariseModels(installationId) {
      const rows = await db.query<{
        model_id: string;
        capability: string;
        samples: number;
        last_seen_at: string;
      }>(
        `SELECT model_id, MAX(capability) AS capability, COUNT(*) AS samples,
                MAX(received_at) AS last_seen_at
           FROM usage_samples
          WHERE installation_id = ?
          GROUP BY model_id
          ORDER BY last_seen_at DESC`,
        [installationId],
      );

      const summaries: UsageSummaryRow[] = [];
      for (const row of rows) {
        const speeds = await db.query<{ tokens_per_second: number }>(
          `SELECT tokens_per_second FROM usage_samples
            WHERE installation_id = ? AND model_id = ? AND tokens_per_second IS NOT NULL
            ORDER BY tokens_per_second ASC`,
          [installationId, row.model_id],
        );
        summaries.push({
          modelId: row.model_id,
          capability: row.capability,
          samples: Number(row.samples),
          medianTokensPerSecond: median(speeds.map((entry) => Number(entry.tokens_per_second))),
          lastSeenAt: row.last_seen_at,
        });
      }

      return summaries;
    },

    async countSamples() {
      const rows = await db.query<{ total: number }>("SELECT COUNT(*) AS total FROM usage_samples");
      return Number(rows[0]?.total ?? 0);
    },
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const middle = Math.floor(values.length / 2);
  const value =
    values.length % 2 === 1 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
  return Math.round(value * 10) / 10;
}
