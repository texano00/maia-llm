import { describe, expect, it } from "vitest";
import { describeBalance } from "../../src/renderer/features/notifications/balance-display";

/** The header badge is a fixed-size control: no label may outgrow it. */
const MAX_COMPACT_GLYPHS = 7; // "$999.99" is the widest label before abbreviation

function compact(microUsd: number | null): string {
  return describeBalance(microUsd).compact;
}

describe("balance display", () => {
  it("shows small amounts with cents", () => {
    expect(compact(0)).toBe("$0.00");
    expect(compact(9_970_000)).toBe("$9.97");
    expect(compact(999_990_000)).toBe("$999.99");
  });

  it("abbreviates thousands so the badge never grows", () => {
    expect(compact(1_000_000_000)).toBe("$1.0k");
    expect(compact(1_234_560_000)).toBe("$1.2k");
    expect(compact(999_000_000_000)).toBe("$999k");
  });

  it("abbreviates millions", () => {
    expect(compact(1_500_000_000_000)).toBe("$1.5m");
  });

  it("never produces a label longer than the badge allows", () => {
    for (const microUsd of [0, 9_970_000, 999_990_000, 1_000_000_000, 1_234_560_000, 99_000_000_000, 999_000_000_000, 1_500_000_000_000]) {
      expect(compact(microUsd).length).toBeLessThanOrEqual(MAX_COMPACT_GLYPHS);
    }
  });

  it("keeps the exact amount for the tooltip and the accessible name", () => {
    const described = describeBalance(1_234_560_000);

    expect(described.compact).toBe("$1.2k");
    expect(described.exact).toBe("$1,234.56");
    expect(described.label).toBe("Balance $1,234.56");
  });

  it("has a distinct unknown state", () => {
    const described = describeBalance(null);

    expect(described.compact).toBe("—");
    expect(described.label).toBe("Balance unavailable");
  });
});
