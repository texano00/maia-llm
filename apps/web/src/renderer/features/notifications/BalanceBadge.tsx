import { useEffect, useRef, useState } from "react";
import type { ProviderHealth } from "@maia/contracts";
import { describeBalance } from "./balance-display";

interface LastReading {
  amountMicroUsd: number;
  checkedAt: string;
}

/**
 * Remaining prepaid compute balance. An unreadable balance shows the last reading
 * labelled with its time, or a dash when there never was one — never zero, and never
 * money that looks current when it is not.
 *
 * The compact amount is all that fits in the header, so the exact figure is one tap
 * away: a phone has no hover, and a `title` attribute alone would keep the precise
 * amount unreachable for the people most likely to check it.
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

  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent): void => {
      if (container.current && !container.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const readingTime = known && balance ? balance.checkedAt : (lastReading?.checkedAt ?? null);
  const readAt = readingTime ? formatReadingTime(readingTime) : null;
  const title = stale
    ? `Prepaid GPU balance at vast.ai was ${display.exact} at ${readAt}. It could not be read just now.`
    : known
      ? `Prepaid GPU balance at vast.ai: ${display.exact}`
      : "Prepaid GPU balance is not available right now.";

  return (
    <div className="balance" ref={container}>
      <button
        type="button"
        className={`icon-button balance-badge${known ? " balance-known" : ""}${stale ? " balance-stale" : ""}`}
        title={title}
        aria-label={stale ? `${display.label}, not current` : display.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="balance-amount">{display.compact}</span>
      </button>

      {open ? (
        <div className="balance-panel" role="dialog" aria-label="Prepaid GPU balance">
          <p className="info-row">
            <span>Balance</span>
            <strong>{display.exact || "unavailable"}</strong>
          </p>
          <p className="info-row">
            <span>Read</span>
            <strong>{readAt ?? "never"}</strong>
          </p>
          {stale ? (
            <p className="field-hint">Not current: the last check could not reach vast.ai.</p>
          ) : null}
          {!known && !stale ? (
            <p className="field-hint">Add a vast.ai key in settings to see your balance.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatReadingTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? "an earlier check"
    : parsed.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
