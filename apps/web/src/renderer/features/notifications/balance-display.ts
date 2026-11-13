/** Money always arrives as integer micro-USD; presentation is the only place it becomes text. */
const MICRO = 1_000_000;

export interface BalanceDisplay {
  /** Fits the fixed-size header badge. */
  compact: string;
  /** Full amount, for the tooltip. */
  exact: string;
  /** Accessible name, so a screen reader hears the exact amount. */
  label: string;
}

const UNKNOWN: BalanceDisplay = {
  compact: "—",
  exact: "",
  label: "Balance unavailable"
};

function group(amount: number): string {
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * The header badge is a fixed-size control, so the label may never grow past the
 * widest realistic amount ("$999.99", seven glyphs). Cents are shown where they
 * help, thousands and millions are abbreviated, and the exact figure stays one
 * hover away.
 */
export function describeBalance(amountMicroUsd: number | null): BalanceDisplay {
  if (amountMicroUsd === null || !Number.isFinite(amountMicroUsd)) {
    return UNKNOWN;
  }

  const amount = Math.max(0, amountMicroUsd) / MICRO;
  const exact = `$${group(amount)}`;

  if (amount < 1000) {
    return { compact: exact, exact, label: `Balance ${exact}` };
  }

  if (amount < 1_000_000) {
    const thousands = amount / 1000;
    // 999k, 12k, 1.2k: one decimal only while it changes the reading.
    const compact = `$${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`;
    return { compact, exact, label: `Balance ${exact}` };
  }

  const millions = amount / 1_000_000;
  const compact = `$${millions >= 100 ? Math.round(millions) : millions.toFixed(1)}m`;
  return { compact, exact, label: `Balance ${exact}` };
}
