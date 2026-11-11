import type { ProviderHealth } from "@maia/contracts";
import { formatUsd } from "../../shared/format";

/**
 * Remaining prepaid compute balance. Purely informational: activating it does
 * nothing. An unreadable balance shows a dash, never zero.
 */
export function BalanceBadge({ health }: { health: ProviderHealth | null }) {
  const balance = health?.balance;
  const known = balance?.state === "known";
  const amount = known ? balance.amountMicroUsd : null;

  return (
    <span
      className={known ? "icon-button balance-badge balance-known" : "icon-button balance-badge"}
      title={
        known
          ? `Prepaid GPU balance at vast.ai: ${formatUsd(amount!)}`
          : "Prepaid GPU balance is not available right now."
      }
      aria-label={known ? `Balance ${formatUsd(amount!)}` : "Balance unavailable"}
    >
      <span aria-hidden="true">$</span>
      <span className="balance-amount">{known ? formatUsd(amount!) : "—"}</span>
    </span>
  );
}
