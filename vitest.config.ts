import { defineConfig } from "vitest/config";

export default defineConfig({
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
