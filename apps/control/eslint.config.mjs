import js from "@eslint/js"
import globals from "globals"
import next from "@next/eslint-plugin-next"
import jsxA11y from "eslint-plugin-jsx-a11y"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"

/**
 * Static analysis for the control panel, type-aware like the admin's
 * (AUDIT-020), so a forgotten `await` or an unhandled promise fails lint.
 */
export default defineConfig([
  globalIgnores([".next/**", "node_modules/**", "coverage/**", "next-env.d.ts"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@next/next": next, "jsx-a11y": jsxA11y },
    settings: { next: { rootDir: import.meta.dirname } },
    rules: {
      ...next.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
])
