import { z } from "zod";
import { accountSummarySchema } from "./capabilities";

/**
 * The server-to-server contract between the portal's accounts view and the
 * product (`/internal/*`). It is token-authenticated, never reachable from the
 * internet, and returns a narrow projection: no settings, conversations or
 * secrets.
 *
 * Signing into the portal does not travel through here: the backoffice keeps its
 * own administrator, configured on the deployment (see `docs/portal.md`).
 */

export const internalAccountQuerySchema = z.object({
  query: z.string().trim().max(254).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const internalAccountListSchema = z.object({
  total: z.number().int().nonnegative(),
  accounts: z.array(accountSummarySchema)
});

/**
 * Paging and window for one account's detail page.
 *
 * `windowDays` bounds the usage aggregation; the history pager is independent, so
 * scrolling back through runs never changes the totals at the top of the page.
 */
export const accountDetailQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0)
});

export const internalErrorSchema = z.object({
  error: z.string()
});

export type InternalAccountQuery = z.infer<typeof internalAccountQuerySchema>;
export type InternalAccountList = z.infer<typeof internalAccountListSchema>;
