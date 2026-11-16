import type { CoverageOptions } from "vitest/node";

/**
 * What every package measures, so the four suites report the same way.
 *
 * No threshold (AUDIT-021): CI publishes the numbers for a month first, and
 * only then do the measured figures become floors. Coverage is off by default
 * and turned on with `--coverage`, so an ordinary `pnpm test` stays fast.
 */
export const coverageConfig: CoverageOptions = {
  provider: "v8",
  reporter: ["text-summary", "json-summary", "lcov"],
  reportsDirectory: "./coverage",
  // Every source file here is counted, not only the ones a test imported, so an
  // untested file shows as zero rather than vanishing. The dashboard's pages are
  // left out: the browser journeys cover them, and Vitest cannot see that.
  include: ["src/**/*.{ts,tsx}", "app/api/**/*.ts"],
  exclude: [
    "**/*.test.{ts,tsx}",
    "**/*.test-d.{ts,tsx}",
    "**/*.testing.{ts,tsx}",
    "**/*.d.ts",
    "**/__snapshots__/**",
    "**/dist/**",
    "**/.next/**",
    "**/migrations/**",
  ],
};
