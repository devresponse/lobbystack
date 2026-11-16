#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Lists the browser journeys that only passed on a retry (AUDIT-021).
 *
 * CI retries a failed journey twice, so a flaky one leaves the job green and
 * nobody sees it. This reads Playwright's JSON report and names them in the
 * job summary. It never fails the job: Playwright already decides that.
 */

const report = fileURLToPath(new URL("../apps/admin/playwright-report/results.json", import.meta.url));

function journeys(suite, path = []) {
  const title = [...path, suite.title].filter(Boolean);
  return [
    ...(suite.specs ?? []).flatMap((spec) => (spec.tests ?? []).map((test) => ({
      title: [...title, spec.title].join(" › "),
      status: test.status,
      attempts: (test.results ?? []).length,
    }))),
    ...(suite.suites ?? []).flatMap((child) => journeys(child, title)),
  ];
}

let results;
try {
  results = JSON.parse(readFileSync(report, "utf8"));
} catch {
  process.stdout.write("No Playwright JSON report to read; skipping the flaky journey list.\n");
  process.exit(0);
}

const flaky = (results.suites ?? []).flatMap((suite) => journeys(suite)).filter((journey) => journey.status === "flaky");
const lines = flaky.length
  ? ["## Flaky journeys", "", "These passed only after a retry, so the job is green but the journey is not reliable.", "",
     ...flaky.map((journey) => `- ${journey.title} (${journey.attempts} attempts)`), ""]
  : ["## Flaky journeys", "", "None: every journey passed on its first attempt.", ""];

const text = `${lines.join("\n")}\n`;
process.stdout.write(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
