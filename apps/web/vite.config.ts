import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rendererRoot = fileURLToPath(new URL("./src/renderer", import.meta.url));
const outDir = fileURLToPath(new URL("./out/renderer", import.meta.url));

/**
 * The renderer is the whole UI now: `src/web/server.ts` serves this bundle from
 * `out/renderer` and answers `/rpc` and `/events`, so one build is the app.
 */
export default defineConfig({
  root: rendererRoot,
  base: "/",
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true
  }
});
