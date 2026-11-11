import { DEFAULT_API_BASE_URL, type AppSettings, type Session, type UsageSample } from "@maia/contracts";
import type { InstallationFacts } from "./identity";

export interface RunMetricInput {
  outputTokens: number | null;
  generationMs: number | null;
  tokensPerSecond: number | null;
  outcome: "completed" | "failed" | "cancelled" | "capped" | "idle";
}

/** Builds exactly the allowlisted sample: no prompt, response, image or path. */
export function buildUsageSample(
  facts: InstallationFacts,
  session: Session,
  metric: RunMetricInput,
  occurredAt: string
): UsageSample {
  return {
    installationId: facts.installationId,
    appVersion: facts.appVersion,
    os: facts.os,
    osVersion: facts.osVersion,
    arch: facts.arch,
    deviceClass: facts.deviceClass,
    modelId: session.modelId,
    capability: session.capability ?? "text",
    outputTokens: metric.outputTokens,
    generationMs: metric.generationMs,
    tokensPerSecond: metric.tokensPerSecond,
    outcome: metric.outcome,
    occurredAt
  };
}

export interface UsageReporterOptions {
  settings: () => AppSettings;
  facts: () => InstallationFacts;
  /** Returns true when the server accepted the request. */
  post: (path: string, body: unknown) => Promise<boolean>;
  now?: () => Date;
}

/**
 * Sends one sample per completed run, and only while the user has reporting on.
 * The gate is evaluated at send time, so turning reporting off stops the very
 * next run even if a queued callback still fires.
 */
export class UsageReporter {
  constructor(private readonly options: UsageReporterOptions) {}

  async report(session: Session, metric: RunMetricInput): Promise<boolean> {
    if (!this.options.settings().usageReporting) {
      return false;
    }

    const occurredAt = (this.options.now?.() ?? new Date()).toISOString();
    return this.options.post("/api/v0/usage", buildUsageSample(this.options.facts(), session, metric, occurredAt));
  }

  /** Signals opt-in/opt-out so the portal can refuse later samples. */
  async preference(optedIn: boolean): Promise<boolean> {
    const facts = this.options.facts();
    const occurredAt = (this.options.now?.() ?? new Date()).toISOString();
    return this.options.post(optedIn ? "/api/v0/usage/opt-in" : "/api/v0/usage/opt-out", {
      installationId: facts.installationId,
      occurredAt
    });
  }
}

/** Default transport: plain JSON POST, never throwing into the session path. */
export async function postUsage(path: string, body: unknown): Promise<boolean> {
  try {
    const response = await fetch(`${DEFAULT_API_BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return response.ok;
  } catch {
    return false;
  }
}
