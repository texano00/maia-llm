import { readFileSync } from "node:fs";

/**
 * A preload script runs with `sandbox: true`, where `require` only resolves
 * "electron". Any other externalised dependency throws at load time and the
 * bridge is never exposed — which shows up as a renderer where every IPC call
 * silently does nothing. Catch it at build time instead.
 */
const PRELOAD_ENTRY = "apps/desktop/out/preload/index.js";
const ALLOWED = new Set(["electron"]);

let code;
try {
  code = readFileSync(PRELOAD_ENTRY, "utf8");
} catch {
  console.error(`[verify:preload] missing ${PRELOAD_ENTRY}; run the desktop build first`);
  process.exit(1);
}

const required = new Set([...code.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]));
const unexpected = [...required].filter((moduleName) => !ALLOWED.has(moduleName));

if (unexpected.length > 0) {
  console.error(
    `[verify:preload] the sandboxed preload may only require "electron", found: ${unexpected.join(", ")}`
  );
  process.exit(1);
}

console.log(`[verify:preload] ok (${[...required].join(", ") || "no requires"})`);
