import { fileURLToPath } from "node:url";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: `${rootDir}/src/main/bootstrap/main.ts`
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: `${rootDir}/src/preload/index.ts`
      }
    }
  },
  renderer: {
    root: `${rootDir}/src/renderer`,
    build: {
      rollupOptions: {
        input: `${rootDir}/src/renderer/index.html`
      }
    },
    plugins: [react()]
  }
});
