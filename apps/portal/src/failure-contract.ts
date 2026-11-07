import { z } from "zod";

/**
 * The telemetry API is a standalone service: like `diagnostics.ts` it keeps its
 * own copies of the wire schemas instead of importing the desktop contracts
 * package (different module resolution and deployment lifecycle).
 *
 * Keep in sync with `packages/contracts/src/failure.ts`.
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
  attempt: z.number().int().nonnegative().nullish(),
  attemptsTotal: z.number().int().nonnegative().nullish(),
  errorClass: z.string().min(1).max(80),
  errorMessage: z.string().min(1).max(2_000),
  rootCause: z.string().max(400).nullish(),
  memoryNote: z.string().max(400).nullish(),
  modelFailure: z.string().max(400).nullish(),
  contextScale: z.number().positive().max(1).nullish(),
  logTail: z.string().max(4_000).nullish()
});

export type FailureReport = z.infer<typeof failureReportSchema>;
