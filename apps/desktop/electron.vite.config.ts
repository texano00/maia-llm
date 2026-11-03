import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const alias = {
  "@maia/contracts": resolve(rootDir, "../../packages/contracts/src/index.ts"),
  "@maia/shared": resolve(rootDir, "../../packages/shared/src/index.ts")
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: `${rootDir}/src/main/bootstrap/main.ts`
      }
    }
  },
  preload: {
    // A sandboxed preload may only require("electron"); everything else has to be
    // bundled or the bridge silently never gets exposed. `npm run verify:preload`
    // enforces that.
    plugins: [externalizeDepsPlugin({ exclude: ["zod"] })],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: `${rootDir}/src/preload/index.ts`
      }
    }
  },
  renderer: {
    root: `${rootDir}/src/renderer`,
    resolve: { alias },
    build: {
      rollupOptions: {
        input: `${rootDir}/src/renderer/index.html`
      }
    },
    plugins: [react()]
  }
});
