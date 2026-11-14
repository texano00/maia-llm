/**
 * Layout rules for specs/008-mobile-ready-surfaces.
 *
 * One source for the numbers the stylesheets use and the contract test asserts, so
 * a breakpoint cannot be changed in CSS without the test noticing. The tiers are
 * keyed on width, never on a device name: a foldable, a tablet in split view and a
 * small laptop all get whatever shape their width can carry.
 */

/** Below this width the product is in its phone shape. */
export const PHONE_MAX_WIDTH = 640;

/** Last width in the tablet shape; at the next pixel the desktop shape returns. */
export const TABLET_MAX_WIDTH = 1023;

/** The tap floor. Above the legal minimum on purpose: phones are used one-handed. */
export const TAP_TARGET_PX = 44;

/** Space between adjacent controls so a thumb cannot hit two at once. */
export const TAP_GAP_PX = 8;

/** Body text never goes below this; below it, browsers zoom on focus anyway. */
export const MIN_BODY_FONT_PX = 16;

/** The widths the contract is verified at (quickstart + tests). */
export const VERIFIED_WIDTHS_PX = [320, 360, 390, 414, 768] as const;

export type LayoutTier = "phone" | "tablet" | "desktop";

export function layoutTier(width: number): LayoutTier {
  if (width <= PHONE_MAX_WIDTH) {
    return "phone";
  }

  return width <= TABLET_MAX_WIDTH ? "tablet" : "desktop";
}

/**
 * Actions that used to be reachable only on hover. Each one has a tap route now;
 * the list exists so a new hover-only affordance cannot slip in unnoticed.
 */
export const TAP_REACHABLE_ACTIONS = [
  "balance-exact-amount",
  "build-information",
  "history-row-actions",
  "notification-dismiss"
] as const;
