import { z } from "zod";
import { providerModeSchema, releaseChannelSchema } from "@maia/contracts";

const appConfigSchema = z.object({
  providerMode: providerModeSchema,
  releaseChannel: releaseChannelSchema,
  idleTimeoutMinutes: z.number().int().min(1).max(120),
  updateCheckIntervalHours: z.number().int().min(1).max(168),
  simulatedUpdateVersion: z.string().min(1).optional(),
  updateFeedUrl: z.string().min(1).optional(),
  diagnosticLogUrl: z.string().min(1).optional()
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return appConfigSchema.parse({
    providerMode: env.MAIA_PROVIDER_MODE === "live" ? "live" : "mock",
    releaseChannel: env.MAIA_RELEASE_CHANNEL === "beta" ? "beta" : "stable",
    idleTimeoutMinutes: parseInteger(env.MAIA_IDLE_TIMEOUT_MINUTES, 10),
    updateCheckIntervalHours: parseInteger(env.MAIA_UPDATE_CHECK_INTERVAL_HOURS, 24),
    simulatedUpdateVersion: env.MAIA_UPDATE_SIMULATE_VERSION?.trim() || undefined,
    updateFeedUrl: env.MAIA_UPDATE_FEED_URL?.trim() || undefined,
    diagnosticLogUrl: env.MAIA_DIAGNOSTIC_LOG_URL?.trim() || undefined
  });
}

function parseInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
