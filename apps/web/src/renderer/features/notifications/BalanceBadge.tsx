import type { ProviderHealth } from "@maia/contracts";
import { describeBalance } from "./balance-display";

/**
 * Remaining prepaid compute balance. Purely informational: activating it does
 * nothing. An unreadable balance shows a dash, never zero, and the label is
 * abbreviated so a large amount cannot push the control out of its box.
 */
export function BalanceBadge({ health }: { health: ProviderHealth | null }) {
  const balance = health?.balance;
  const known = balance?.state === "known";
  const display = describeBalance(known ? balance.amountMicroUsd : null);

  return (
    <span
      className={known ? "icon-button balance-badge balance-known" : "icon-button balance-badge"}
      title={
        known
          ? `Prepaid GPU balance at vast.ai: ${display.exact}`
          : "Prepaid GPU balance is not available right now."
      }
      aria-label={display.label}
    >
      <span className="balance-amount">{display.compact}</span>
    </span>
  );
}
