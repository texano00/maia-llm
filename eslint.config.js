import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/src/renderer/index.html"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module"
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_"
        }
      ]
    }
  }
);
