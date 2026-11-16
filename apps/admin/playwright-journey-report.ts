import type { PlaywrightTestConfig } from "@playwright/test";

/**
 * The reporters for one run of the browser journeys.
 *
 * In CI each run writes a JSON report, which scripts/flaky-journeys.mjs reads
 * to name the journeys that passed only after a retry (AUDIT-021). The e2e job
 * runs the journeys several times over, against servers started differently,
 * and the runs share a folder. So each report carries its run's name: under
 * one name for all of them, the last run's report replaced the others', and
 * only that run's journeys were ever listed.
 */
export function journeyReporters(run: string, env: Record<string, string | undefined> = process.env): NonNullable<PlaywrightTestConfig["reporter"]> {
  return env.CI ? [["github"], ["json", { outputFile: `playwright-report/results-${run}.json` }]] : "list";
}
