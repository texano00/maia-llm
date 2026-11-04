import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const repo = process.cwd();

export default defineConfig({
  root: `${repo}/apps/desktop/src/renderer`,
  resolve: {
    alias: {
      "@maia/contracts": resolve(repo, "packages/contracts/src/index.ts"),
      "@maia/shared": resolve(repo, "packages/shared/src/index.ts")
    }
  },
  server: { port: 5199, strictPort: true, fs: { allow: [repo] } },
  plugins: [react()]
});
