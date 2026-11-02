import { z } from "zod";
import { providerModeSchema, releaseChannelSchema } from "@maia/contracts";

const appConfigSchema = z.object({
  providerMode: providerModeSchema,
  releaseChannel: releaseChannelSchema,
  idleTimeoutMinutes: z.number().int().min(1).max(120)
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return appConfigSchema.parse({
    providerMode: env.MAIA_PROVIDER_MODE === "mock" ? "mock" : "live",
    releaseChannel: env.MAIA_RELEASE_CHANNEL === "beta" ? "beta" : "stable",
    idleTimeoutMinutes: Number(env.MAIA_IDLE_TIMEOUT_MINUTES ?? "10")
  });
}
