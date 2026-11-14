import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MIN_BODY_FONT_PX,
  PHONE_MAX_WIDTH,
  TAP_REACHABLE_ACTIONS,
  TAP_TARGET_PX,
  VERIFIED_WIDTHS_PX,
  layoutTier
} from "../../src/renderer/shared/layout";

/**
 * The layout rules from `specs/008-mobile-ready-surfaces/contracts/responsive-contract.md`
 * that can be asserted without a browser.
 *
 * A phone-shaped product is mostly a stylesheet property, so the risks are the
 * ones nobody notices on a desktop screen: a breakpoint that drifts away from the
 * number the components assume, a `min-width` that forces a page sideways, an
 * action that only appears on hover. These assertions are cheap and catch exactly
 * those.
 */

const ROOT = process.cwd();
const THEME_CSS = join(ROOT, "apps/web/src/renderer/shared/theme.css");
const PORTAL_CSS = join(ROOT, "apps/portal/ui/src/styles.css");
const PORTAL_APP = join(ROOT, "apps/portal/ui/src/App.jsx");
const PRODUCT_SHELL = join(ROOT, "apps/web/src/renderer/index.html");
const PORTAL_SHELL = join(ROOT, "apps/portal/ui/index.html");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Removes comments so a rule that is only described in prose cannot pass a check. */
function rules(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("layout tiers", () => {
  it("classifies the verified widths the way the contract does", () => {
    expect(layoutTier(320)).toBe("phone");
    expect(layoutTier(PHONE_MAX_WIDTH)).toBe("phone");
    expect(layoutTier(PHONE_MAX_WIDTH + 1)).toBe("tablet");
    expect(layoutTier(768)).toBe("tablet");
    expect(layoutTier(1024)).toBe("desktop");
    expect(VERIFIED_WIDTHS_PX).toEqual([320, 360, 390, 414, 768]);
  });

  it("uses the same phone breakpoint in both stylesheets", () => {
    for (const path of [THEME_CSS, PORTAL_CSS]) {
      expect(rules(read(path))).toContain(`@media (max-width: ${PHONE_MAX_WIDTH}px)`);
    }
  });

  it("keeps the tap target and body text at the agreed floor", () => {
    expect(TAP_TARGET_PX).toBeGreaterThanOrEqual(44);
    expect(MIN_BODY_FONT_PX).toBeGreaterThanOrEqual(16);

    const theme = rules(read(THEME_CSS));
    expect(theme).toMatch(new RegExp(`--tap-target:\\s*${TAP_TARGET_PX}px`));
    expect(theme).toMatch(new RegExp(`base font[^\\n]*|:root\\s*{[^}]*--tap-target`));
  });
});

describe("no page is forced wider than a phone", () => {
  /**
   * A `min-width` in pixels on a page-level box is the classic way a layout starts
   * scrolling sideways on a phone: the content is fine, the box refuses to shrink.
   * Nothing legitimately needs one above the phone floor.
   */
  it.each([
    ["product", THEME_CSS],
    ["backoffice", PORTAL_CSS]
  ])("%s stylesheet declares no pixel min-width above the phone floor", (_label, path) => {
    const offenders = [...rules(read(path)).matchAll(/min-width:\s*(\d+)px/g)]
      .map((match) => Number(match[1]))
      .filter((value) => value > PHONE_MAX_WIDTH);

    expect(offenders).toEqual([]);
  });
});

describe("nothing is reachable only on hover", () => {
  /**
   * A rule that hides something and reveals it on `:hover` is invisible on a phone
   * and unreachable with a finger. Actions live in the markup and are always
   * rendered; hover may only add emphasis.
   */
  it.each([
    ["product", THEME_CSS],
    ["backoffice", PORTAL_CSS]
  ])("%s stylesheet reveals no action through :hover", (_label, path) => {
    const css = rules(read(path));
    const hoverBlocks = [...css.matchAll(/([^{}]*:hover[^{}]*)\{([^}]*)\}/g)];
    const offenders = hoverBlocks
      .filter(([, , body]) => /(display:\s*none|visibility:\s*hidden|opacity:\s*0\b)/.test(body))
      .map(([whole]) => whole.trim());

    expect(offenders).toEqual([]);
  });

  it("keeps every previously hover-only value on a list with a tap route", () => {
    expect(TAP_REACHABLE_ACTIONS).toContain("balance-exact-amount");
    expect(TAP_REACHABLE_ACTIONS).toContain("build-information");
  });
});

describe("phones can use the whole screen", () => {
  it.each([
    ["product", PRODUCT_SHELL],
    ["backoffice", PORTAL_SHELL]
  ])("%s shell declares viewport-fit=cover", (_label, path) => {
    const html = read(path);
    expect(html).toContain("viewport-fit=cover");
    expect(html).toMatch(/<meta name="viewport" content="width=device-width/);
  });
});

describe("backoffice tables survive a phone", () => {
  /**
   * Below the phone tier the tables render as labelled stacks: each cell shows its
   * column name from `data-label`, which is why the attribute has to exist for every
   * cell rather than for a subset.
   */
  it("labels every table cell", () => {
    const jsx = read(PORTAL_APP);
    const cells = [...jsx.matchAll(/<td\b[^>]*>/g)].map(([tag]) => tag);

    expect(cells.length).toBeGreaterThan(0);
    expect(cells.filter((tag) => !tag.includes("data-label="))).toEqual([]);
  });

  it("keeps table actions as buttons a thumb can hit", () => {
    const jsx = read(PORTAL_APP);
    // Row actions are buttons, not links or table-row clicks.
    expect(jsx).toMatch(/className="ghost"[\s\S]{0,200}?(Grant|Revoke)/);
  });
});
