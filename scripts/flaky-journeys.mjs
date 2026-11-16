#!/usr/bin/env node
import { appendFileSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lists the browser journeys that only passed on a retry (AUDIT-021).
 *
 * CI retries a failed journey twice, so a flaky one leaves the job green and
 * nobody sees it. This reads Playwright's JSON reports and names them in the
 * job summary. It never fails the job: Playwright already decides that.
 *
 * The e2e job runs the journeys several times over, against servers started
 * differently, and each run leaves a report under its own name
 * (apps/admin/playwright-journey-report.ts). Every one of them is read, and
 * the summary says which runs it read and how many journeys each held, so a
 * report that went missing shows instead of reading as "none were flaky".
 */

const reportDirectory = fileURLToPath(new URL("../apps/admin/playwright-report/", import.meta.url));
const reportName = /^results-(.+)\.json$/;

/** Every journey in one report: its title, its project, how it ended and in how many attempts. */
export function journeysIn(report) {
  const walk = (suite, path) => {
    const title = [...path, suite.title].filter(Boolean);
    return [
      ...(suite.specs ?? []).flatMap((spec) => (spec.tests ?? []).map((test) => ({
        title: [...title, spec.title].join(" › "),
        project: test.projectName ?? "",
        status: test.status,
        attempts: (test.results ?? []).length,
      }))),
      ...(suite.suites ?? []).flatMap((child) => walk(child, title)),
    ];
  };
  return (report.suites ?? []).flatMap((suite) => walk(suite, []));
}

/**
 * The summary for the reports of every run, keyed by the run's name, and the
 * names of any report that couldn't be read. Null when there was no report.
 */
export function flakySummary(reports, unreadable = []) {
  const runs = Object.entries(reports).map(([run, report]) => ({ run, journeys: journeysIn(report) }));
  if (runs.length === 0 && unreadable.length === 0) return null;
  const flaky = runs.flatMap(({ run, journeys }) => {
    // A run against several servers has a project for each, and the same journey in every one.
    const severalProjects = new Set(journeys.map((journey) => journey.project)).size > 1;
    return journeys
      .filter((journey) => journey.status === "flaky")
      .map((journey) => `- ${run}${severalProjects ? `, ${journey.project}` : ""}: ${journey.title} (${journey.attempts} attempts)`);
  });
  return [
    "## Flaky journeys",
    "",
    ...(flaky.length
      ? ["These passed only after a retry, so the job is green but the journey is not reliable.", "", ...flaky]
      : ["None: every journey passed on its first attempt."]),
    "",
    `Read ${runs.map(({ run, journeys }) => `${run} (${journeys.length})`).join(", ") || "no report"}.`,
    ...(unreadable.length ? ["", `Could not read ${unreadable.join(", ")}, so its journeys are not counted here.`] : []),
    "",
  ].join("\n");
}

function main() {
  let names = [];
  try {
    names = readdirSync(reportDirectory).filter((name) => reportName.test(name)).sort();
  } catch {
    // No folder: no run got as far as writing a report.
  }
  const reports = {};
  const unreadable = [];
  for (const name of names) {
    try {
      reports[reportName.exec(name)[1]] = JSON.parse(readFileSync(join(reportDirectory, name), "utf8"));
    } catch {
      unreadable.push(name);
    }
  }
  const text = flakySummary(reports, unreadable);
  if (text === null) {
    process.stdout.write("No Playwright JSON report to read; skipping the flaky journey list.\n");
    return;
  }
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
