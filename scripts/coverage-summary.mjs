#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Collects the four suites' coverage reports into one table (AUDIT-021).
 *
 * There is no threshold: the point is that the number exists and is published,
 * so it can be watched for a month before the measured figures become floors.
 * Run it after `pnpm test:coverage`.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const packages = ["apps/admin", "apps/worker", "packages/db", "packages/domain"];

function summaryOf(directory) {
  try {
    return JSON.parse(readFileSync(`${root}${directory}/coverage/coverage-summary.json`, "utf8")).total;
  } catch {
    return null;
  }
}

const rows = packages.map((directory) => ({ directory, total: summaryOf(directory) }));
const missing = rows.filter((row) => !row.total).map((row) => row.directory);

const percent = (metric) => `${metric.pct.toFixed(1)}% (${metric.covered}/${metric.total})`;
const lines = [
  "## Test coverage",
  "",
  "No threshold yet: these numbers are published so they can be watched before they become floors.",
  "",
  "The integration suites skip themselves without a test database, so `packages/domain` and `packages/db` read lower here than what CI's database job exercises.",
  "",
  "| Package | Lines | Statements | Branches | Functions |",
  "| --- | --- | --- | --- | --- |",
  ...rows.map(({ directory, total }) => total
    ? `| \`${directory}\` | ${percent(total.lines)} | ${percent(total.statements)} | ${percent(total.branches)} | ${percent(total.functions)} |`
    : `| \`${directory}\` | no report | | | |`),
  "",
];

const text = `${lines.join("\n")}\n`;
process.stdout.write(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);

if (missing.length) {
  process.stderr.write(`No coverage report for ${missing.join(", ")}. Did \`pnpm test:coverage\` run?\n`);
  process.exit(1);
}
