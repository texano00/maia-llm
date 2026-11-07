import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * Built into `public/admin`, which the portal serves at `/admin`. The base path
 * matters: the SPA and its assets are same-origin, so the admin session cookie
 * is sent without any CORS setup.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, "."),
  base: "/admin/",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "../public/admin"),
    emptyOutDir: true
  },
  server: {
    port: 5174,
    // `dev:admin` needs the API on 8787; production serves both from one origin.
    proxy: {
      "/v1": "http://127.0.0.1:8787"
    }
  }
});
