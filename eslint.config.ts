import eslint from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/.tmp/**", "**/dist/**", "**/node_modules/**", "**/templates/**"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  stylistic.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@stylistic/arrow-parens": ["error", "always"],
      "@stylistic/brace-style": ["error", "1tbs", { allowSingleLine: true }],
      "@stylistic/comma-dangle": ["error", "always-multiline"],
      "@stylistic/indent": ["error", 2],
      "@stylistic/quotes": ["error", "double", { avoidEscape: true }],
      "@stylistic/semi": ["error", "always"],
    },
  },
  {
    files: ["packages/cli/src/{commands,build,yandex-environment,yandex-folder,terraform-environment}.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["./cli.ts", "./push.ts", "./init.ts", "./dev.ts", "./project-delete.ts", "./project-lifecycle.ts"],
          message: "Shared CLI infrastructure must not depend on command orchestration.",
        }],
      }],
    },
  },
  {
    files: ["packages/ai/src/transport.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["./index.js", "./index.ts"],
          message: "AI transport must not depend on the public resource client.",
        }],
      }],
    },
  },
);
