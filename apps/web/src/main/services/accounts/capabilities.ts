import { capabilitySchema, type Capability } from "@maia/contracts";

/**
 * The grants as stored: unknown entries are dropped (a hand-edited row cannot
 * invent authority) and duplicates collapse, but nothing is implied.
 */
export function storedCapabilities(stored: unknown): Capability[] {
  const entries = Array.isArray(stored) ? stored : [];
  const granted = new Set<Capability>();
  for (const entry of entries) {
    const parsed = capabilitySchema.safeParse(entry);
    if (parsed.success) {
      granted.add(parsed.data);
    }
  }
  return [...granted].sort();
}

/**
 * What the product and the portal act on: the stored grants plus the implication
 * that an `operator` is always able to see the developer settings.
 */
export function effectiveCapabilities(stored: unknown): Capability[] {
  const granted = new Set(storedCapabilities(stored));
  if (granted.has("operator")) {
    granted.add("debug");
  }
  return [...granted].sort();
}

export function hasCapability(
  capabilities: readonly Capability[],
  required: Capability
): boolean {
  return capabilities.includes(required);
}

/** First-sign-in grants from `MAIA_OPERATOR_EMAILS`; blanks and duplicates go. */
export function parseOperatorEmails(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const email = part.trim().toLowerCase();
    if (email.length > 0) {
      seen.add(email);
    }
  }
  return [...seen];
}
