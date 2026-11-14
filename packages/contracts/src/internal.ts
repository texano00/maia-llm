import { z } from "zod";
import { accessCodeSchema, accessEmailSchema } from "./auth";
import { accountSummarySchema, capabilitiesSchema } from "./capabilities";

/**
 * The server-to-server contract between the portal and the product
 * (`/internal/*`). It is token-authenticated, never reachable from the internet,
 * and returns a narrow projection: no settings, conversations or secrets.
 */

export const internalRequestCodeSchema = z.object({
  email: accessEmailSchema
});

export const internalVerifyCodeSchema = z.object({
  email: accessEmailSchema,
  code: accessCodeSchema
});

export const internalVerifyResultSchema = z.object({
  accountId: z.string().min(1),
  email: z.string(),
  capabilities: capabilitiesSchema
});

export const internalAccountQuerySchema = z.object({
  query: z.string().trim().max(254).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const internalAccountListSchema = z.object({
  total: z.number().int().nonnegative(),
  accounts: z.array(accountSummarySchema)
});

export const internalErrorSchema = z.object({
  error: z.string(),
  retryAfterSeconds: z.number().int().positive().optional()
});

export type InternalRequestCode = z.infer<typeof internalRequestCodeSchema>;
export type InternalVerifyCode = z.infer<typeof internalVerifyCodeSchema>;
export type InternalVerifyResult = z.infer<typeof internalVerifyResultSchema>;
export type InternalAccountQuery = z.infer<typeof internalAccountQuerySchema>;
export type InternalAccountList = z.infer<typeof internalAccountListSchema>;
