import { z } from "zod";

/**
 * A failed start-up, recorded by the desktop app and stored by the MaiaLLM
 * backend.
 *
 * The point is not accounting: it is that an engine crash in the field is
 * otherwise invisible. The container's own log dies with the instance, so the
 * root-cause line has to travel with the report — scrubbed of secrets and
 * bounded in size.
 */
export const failureReportSchema = z.object({
  appVersion: z.string().min(1).max(64),
  platform: z.string().min(1).max(64),
  stage: z.enum(["provisioning", "startup", "runtime", "shutdown"]),
  occurredAt: z.string().max(40).optional(),
  modelId: z.string().max(200).nullish(),
  gpuName: z.string().max(120).nullish(),
  machineId: z.number().int().nullish(),
  instanceId: z.number().int().nullish(),
  /** Which GPU attempt this was, and how many were allowed in total. */
  attempt: z.number().int().nonnegative().nullish(),
  attemptsTotal: z.number().int().nonnegative().nullish(),
  errorClass: z.string().min(1).max(80),
  errorMessage: z.string().min(1).max(2_000),
  /** The deepest error line found in the container log. */
  rootCause: z.string().max(400).nullish(),
  /** Set when the log shows memory arithmetic rather than a broken model. */
  memoryNote: z.string().max(400).nullish(),
  /** Set when the log identifies a model problem rather than a host problem. */
  modelFailure: z.string().max(400).nullish(),
  /** Context multiplier used for this attempt (1 = the sized budget). */
  contextScale: z.number().positive().max(1).nullish(),
  /** Last lines of the container log, already scrubbed by the client. */
  logTail: z.string().max(4_000).nullish()
});

export type FailureReport = z.infer<typeof failureReportSchema>;

/** What the orchestrator knows; the reporter adds app version and platform. */
export type FailureEvent = Omit<FailureReport, "appVersion" | "platform" | "occurredAt">;
