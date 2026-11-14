import { z } from "zod";

/**
 * Account capabilities (specs/007-setup-notices-and-portal).
 *
 * `operator` grants access to the private portal and implies `debug`; `debug`
 * only reveals the developer settings in the product. Grants are made by an
 * operator through the portal, never by the account itself.
 */
export const capabilitySchema = z.enum(["debug", "operator"]);

export const capabilitiesSchema = z.array(capabilitySchema).max(2);

export type Capability = z.infer<typeof capabilitySchema>;

/** What the portal sees per account; never settings, conversations or secrets. */
export const accountSummarySchema = z.object({
  id: z.string().min(1),
  email: z.string().min(3).max(254),
  createdAt: z.string().min(1),
  lastSeenAt: z.string().nullable(),
  capabilities: capabilitiesSchema,
  /** Runs in an active or serving state for this account. */
  activeSessions: z.number().int().nonnegative()
});

export type AccountSummary = z.infer<typeof accountSummarySchema>;

export const capabilityChangeSchema = z
  .object({
    grant: capabilitySchema.optional(),
    revoke: capabilitySchema.optional(),
    confirm: z.literal(true)
  })
  .refine((value) => (value.grant === undefined) !== (value.revoke === undefined), {
    message: "Exactly one of grant or revoke is required"
  });

export type CapabilityChange = z.infer<typeof capabilityChangeSchema>;
