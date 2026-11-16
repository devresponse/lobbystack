import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { flakySummary, journeysIn } from "./flaky-journeys.mjs";

// The shape Playwright's JSON reporter writes: files, then describes, then specs with a test per project.
const spec = (title: string, tests: Array<{ projectName: string; status: string; attempts: number }>) => ({
  title,
  tests: tests.map(({ attempts, ...test }) => ({ ...test, results: Array.from({ length: attempts }, () => ({})) })),
});
const journeys = {
  suites: [
    { title: "auth-pages.e2e.ts", specs: [spec("login and signup pages expose accessible auth forms", [{ projectName: "chromium", status: "expected", attempts: 1 }])] },
    {
      title: "onboarding-flow.e2e.ts",
      suites: [{ title: "onboarding routing", specs: [spec("resumes the active step", [{ projectName: "chromium", status: "flaky", attempts: 2 }])] }],
    },
  ],
};
const accessGate = { suites: [{ title: "access-gate.e2e.ts", specs: [spec("a stranger gets the same bare 404 at every page", [{ projectName: "chromium", status: "expected", attempts: 1 }])] }] };
const scriptNonce = {
  suites: [{
    title: "script-nonce.e2e.ts",
    specs: [spec("a page keeps working under the nonce", [{ projectName: "reporting", status: "expected", attempts: 1 }, { projectName: "enforced", status: "flaky", attempts: 3 }])],
  }],
};

describe("journeysIn", () => {
  it("names a journey by its file, its describe and its title", () => {
    expect(journeysIn(journeys)).toEqual([
      { title: "auth-pages.e2e.ts › login and signup pages expose accessible auth forms", project: "chromium", status: "expected", attempts: 1 },
      { title: "onboarding-flow.e2e.ts › onboarding routing › resumes the active step", project: "chromium", status: "flaky", attempts: 2 },
    ]);
  });

  it("reads a report with nothing in it as no journeys", () => {
    expect(journeysIn({})).toEqual([]);
  });
});

describe("flakySummary", () => {
  it("names the journeys that needed a retry in every run, not only the last", () => {
    const summary = flakySummary({ "access-gate": accessGate, journeys, "script-nonce": scriptNonce });

    expect(summary).toContain("- journeys: onboarding-flow.e2e.ts › onboarding routing › resumes the active step (2 attempts)");
    // The same journey ran against two servers, so the line says which one.
    expect(summary).toContain("- script-nonce, enforced: script-nonce.e2e.ts › a page keeps working under the nonce (3 attempts)");
    expect(summary).not.toContain("None:");
  });

  it("says which runs it read and how many journeys each held, so a missing report shows", () => {
    expect(flakySummary({ "access-gate": accessGate, journeys })).toContain("Read access-gate (1), journeys (2).");
  });

  it("says none were flaky only for the runs it read", () => {
    const summary = flakySummary({ "access-gate": accessGate });

    expect(summary).toContain("None: every journey passed on its first attempt.");
    expect(summary).toContain("Read access-gate (1).");
  });

  it("says so when a run's report could not be read", () => {
    expect(flakySummary({ journeys }, ["results-access-gate.json"])).toContain("Could not read results-access-gate.json, so its journeys are not counted here.");
  });

  it("has nothing to say when no run left a report", () => {
    expect(flakySummary({})).toBeNull();
  });
});

// Until this test, every run wrote playwright-report/results.json. The access
// gate's run came last, so its five journeys were the only ones ever listed.
describe("the runs' reports", () => {
  const admin = fileURLToPath(new URL("../apps/admin/", import.meta.url));
  const configs = readdirSync(admin)
    .filter((name) => /^playwright\.(.+\.)?config\.ts$/.test(name))
    .map((name) => ({ name, source: readFileSync(`${admin}${name}`, "utf8") }));
  const runOf = (source: string) => /reporter: journeyReporters\("([^"]+)"\)/.exec(source)?.[1];

  it("gives the journeys and every run copied from them a report under its own name", () => {
    const copies = configs.filter(({ name, source }) => name === "playwright.config.ts" || source.includes('from "./playwright.config"'));
    const runs = copies.map(({ name, source }) => ({ name, run: runOf(source) }));

    expect(runs.map(({ name }) => name).sort()).toEqual(["playwright.access-gate.config.ts", "playwright.config.ts", "playwright.script-nonce.config.ts"]);
    // A copy without one inherits the journeys' report and writes over it.
    expect(runs.filter(({ run }) => !run)).toEqual([]);
    expect(new Set(runs.map(({ run }) => run)).size).toBe(runs.length);
  });
});
