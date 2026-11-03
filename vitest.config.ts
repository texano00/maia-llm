import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const contractsPath = fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url));
const sharedPath = fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@maia/contracts": contractsPath,
      "@maia/shared": sharedPath
    }
  },
  test: {
    include: [
      "apps/desktop/tests/**/*.test.ts",
      "apps/telemetry-api/tests/**/*.test.ts",
      "packages/**/tests/**/*.test.ts",
      "scripts/**/tests/**/*.test.ts"
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/tests/e2e/**",
      "**/*.spec.ts"
    ],
    environment: "node",
    restoreMocks: true
  }
});
