/* global document, window */
/**
 * Viewport sweep for the product's four routes.
 *
 * The stylesheet contract test proves the rules exist; this proves a rendered
 * box respects them. It is a manual check because Playwright is not a project
 * dependency and the walk needs a signed-in session.
 *
 * Usage:
 *   npx playwright install chromium
 *   MAIA_E2E_URL=http://127.0.0.1:5433 \
 *   MAIA_E2E_COOKIE='maia_session=…' \
 *   node scripts/e2e/layout-sweep.mjs
 *
 * The cookie can be copied from the browser's devtools after signing in.
 */
const BASE = process.env.MAIA_E2E_URL ?? "http://127.0.0.1:5433";
const COOKIE = process.env.MAIA_E2E_COOKIE ?? "";
const WIDTHS = [320, 360, 390, 414, 768];
const ROUTES = ["/catalogue", "/models", "/chat", "/settings"];

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error(
      "Playwright is not installed. Run `npx playwright install chromium` and `npm i -D playwright` first."
    );
    process.exitCode = 1;
    return;
  }

  const browser = await chromium.launch();
  const failures = [];

  try {
    const context = await browser.newContext();

    if (COOKIE) {
      const [name, value] = COOKIE.split("=");
      await context.addCookies([
        { name, value, url: BASE, httpOnly: true, sameSite: "Lax" }
      ]);
    }

    const page = await context.newPage();

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });

      for (const route of ROUTES) {
        await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
        const overflow = await page.evaluate(() => {
          const root = document.scrollingElement ?? document.documentElement;
          return { scrollWidth: root.scrollWidth, innerWidth: window.innerWidth };
        });

        if (overflow.scrollWidth > overflow.innerWidth + 1) {
          failures.push(
            `${route} at ${width}px scrolls sideways (${overflow.scrollWidth} > ${overflow.innerWidth})`
          );
        } else {
          console.log(`ok   ${route} at ${width}px`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} overflow(s):`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`\nNo horizontal overflow at ${WIDTHS.join(", ")} px.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
