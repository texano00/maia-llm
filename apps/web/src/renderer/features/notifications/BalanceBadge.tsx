import { useEffect, useState } from "react";
import type { ProviderHealth } from "@maia/contracts";
import { describeBalance } from "./balance-display";

interface LastReading {
  amountMicroUsd: number;
  checkedAt: string;
}

/**
 * Remaining prepaid compute balance. Purely informational: activating it does
 * nothing. An unreadable balance shows the last reading labelled with its time,
 * or a dash when there never was one — never zero, and never money that looks
 * current when it is not.
 */
export function BalanceBadge({ health }: { health: ProviderHealth | null }) {
  const balance = health?.balance;
  const known = balance?.state === "known";
  const amount = known && balance ? balance.amountMicroUsd : null;

  // A failed refresh must not blank the header: the last amount stays visible,
  // clearly marked as old, until a reading succeeds again.
  const [lastReading, setLastReading] = useState<LastReading | null>(null);
  useEffect(() => {
    if (known && balance) {
      setLastReading({ amountMicroUsd: balance.amountMicroUsd, checkedAt: balance.checkedAt });
    }
  }, [known, known && balance ? balance.amountMicroUsd : null, known && balance ? balance.checkedAt : null]);

  const shown = known ? amount : (lastReading?.amountMicroUsd ?? null);
  const stale = !known && lastReading !== null;
  const display = describeBalance(shown);

  const readAt = stale && lastReading ? formatReadingTime(lastReading.checkedAt) : null;
  const title = stale
    ? `Prepaid GPU balance at vast.ai was ${display.exact} at ${readAt}. It could not be read just now.`
    : known
      ? `Prepaid GPU balance at vast.ai: ${display.exact}`
      : "Prepaid GPU balance is not available right now.";

  return (
    <span
      className={`icon-button balance-badge${known ? " balance-known" : ""}${stale ? " balance-stale" : ""}`}
      title={title}
      aria-label={stale ? `${display.label}, not current` : display.label}
    >
      <span className="balance-amount">{display.compact}</span>
    </span>
  );
}

function formatReadingTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? "an earlier check"
    : parsed.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
