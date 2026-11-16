import js from "@eslint/js"
import globals from "globals"
import reactHooks from "eslint-plugin-react-hooks"
import next from "@next/eslint-plugin-next"
import jsxA11y from "eslint-plugin-jsx-a11y"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"

/**
 * Static analysis for the admin app. Type checking stays in `pnpm typecheck`;
 * this config covers the runtime hazards TypeScript cannot see.
 *
 * It is type-aware (AUDIT-020): `recommendedTypeChecked` reads the program, so
 * the rules below can tell a promise from a value. Without it a forgotten
 * `await` and a `fetch(...)` nobody handles were invisible to every tool the
 * repository runs. Reading the program costs about 45 seconds and more memory
 * than Node gives a script by default, which is why `pnpm lint` starts ESLint
 * through `node --max-old-space-size=4096` instead of the usual shim.
 *
 * The rules that come with that set and are turned off below are not
 * judgements about the code: each has hundreds of hits that are a project of
 * their own, and leaving them on as warnings would bury the ones that matter.
 * Their counts on 2026-11-16 are written beside them, so the next person can
 * see whether a family is shrinking.
 */

/**
 * The routes that still select from tables themselves (AUDIT-014). Each one moves
 * into a domain function shared with the v1 API; this list only ever gets shorter,
 * and nothing is added to it.
 */
const routesStillQueryingTables = [
  "app/api/activation/route.ts",
  "app/api/affiliate/route.ts",
  "app/api/agent/route.ts",
  "app/api/billing/checkout/route.ts",
  "app/api/billing/portal/route.ts",
  "app/api/billing/route.ts",
  "app/api/businesses/cancellation/route.ts",
  "app/api/integrations/route.ts",
  "app/api/phone-numbers/route.ts",
  "app/api/team/route.ts",
  "app/api/webhooks/resend/route.ts",
  "app/api/widget/lead/route.ts",
]
export default defineConfig([
  globalIgnores([".next/**", "node_modules/**", "test-results/**", "playwright-report/**", "coverage/**", "next-env.d.ts"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "react-hooks": reactHooks, "@next/next": next, "jsx-a11y": jsxA11y },
    settings: { next: { rootDir: import.meta.dirname } },
    rules: {
      ...next.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      // A promise nobody waits for loses its error and finishes whenever it
      // likes. React's `act` is the exception: with a synchronous callback it
      // returns a thenable the React docs say not to await.
      "@typescript-eslint/no-floating-promises": ["error", {
        allowForKnownSafeCalls: [{ from: "package", package: "react", name: "act" }],
      }],
      // An async function handed to something expecting none: its rejection
      // goes nowhere. `attributes: false` leaves React's own event handlers
      // alone, where `onSubmit={async () => …}` is how the framework is used.
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      // A helper here answers a request by throwing the Response, which
      // `asApiResponse` catches. See docs/reference/routes.md.
      "@typescript-eslint/only-throw-error": "off",
      // These reject with a reason that is already someone else's: a caught
      // `unknown`, or `signal.reason` from an AbortSignal. The rule can't tell
      // that from rejecting with a string.
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      // Each of these is its own piece of work, counted on 2026-11-16. Take a
      // family on, fix it, and delete its line; never raise a number.
      "@typescript-eslint/require-await": "off", // 566
      "@typescript-eslint/no-unsafe-member-access": "off", // 328
      "@typescript-eslint/no-unsafe-assignment": "off", // 302
      "@typescript-eslint/no-unnecessary-type-assertion": "off", // 217
      "@typescript-eslint/no-base-to-string": "off", // 83
      "@typescript-eslint/no-unsafe-argument": "off", // 68
      "@typescript-eslint/no-unsafe-call": "off", // 67
      "@typescript-eslint/no-unsafe-return": "off", // 49
      "@typescript-eslint/unbound-method": "off", // 9
      "@typescript-eslint/no-redundant-type-constituents": "off", // 4
      "@typescript-eslint/restrict-template-expressions": "off", // 3
      // Existing step forms intentionally focus their primary control.
      "jsx-a11y/no-autofocus": "warn",
      // Adopt compiler migration rules separately from the core Hooks checks.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Server actions and route handlers legitimately accept untyped payloads.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    /**
     * A dashboard route asks the domain, which is also what the v1 API asks, so one
     * question has one answer (AUDIT-014). These exports of @lobbystack/db are not
     * tables, so a route may still open a transaction or check the database is up.
     */
    files: ["app/api/**/*.ts"],
    ignores: ["**/*.test.ts", ...routesStillQueryingTables],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{
          name: "@lobbystack/db",
          allowImportNames: ["databaseHealthCheck", "enqueueOutbox", "withBusinessTransaction", "withDispatcherTransaction", "DatabaseTransaction"],
          message: "Ask the domain for the data instead of selecting from a table here: packages/domain/src/server. See docs/reference/routes.md.",
        }],
      }],
    },
  },
  {
    // AUDIT-010: a query built as a template string puts whatever is
    // interpolated into it straight into the SQL. `sql` from drizzle-orm makes
    // every value a bind parameter; `sql.raw` is for fixed text written here.
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.property.name='execute'] > TemplateLiteral",
        message: "Write the query as a drizzle `sql` template, so each value is a bind parameter rather than text in the SQL.",
      }],
    },
  },
  {
    // This primitive forwards htmlFor and children from its call sites.
    files: ["src/components/ui/label.tsx"],
    rules: { "jsx-a11y/label-has-associated-control": "off" },
  },
  {
    // These elements play live WebRTC streams, not captionable media files.
    files: ["src/components/widget/widget-chat-client.tsx"],
    rules: { "jsx-a11y/media-has-caption": "off" },
  },
  {
    // Test files assert on partial fixtures and mocked modules.
    files: ["**/*.test.{ts,tsx}", "**/*.test-d.{ts,tsx}"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
])
