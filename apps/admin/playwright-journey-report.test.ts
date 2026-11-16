import { expect, it } from "vitest";

import { journeyReporters } from "./playwright-journey-report";

it("gives each run in CI a report of its own, where the flaky list finds it", () => {
  expect(journeyReporters("journeys", { CI: "true" })).toEqual([["github"], ["json", { outputFile: "playwright-report/results-journeys.json" }]]);
  expect(journeyReporters("access-gate", { CI: "true" })).toEqual([["github"], ["json", { outputFile: "playwright-report/results-access-gate.json" }]]);
});

it("prints a list on a developer's machine and leaves no report behind", () => {
  expect(journeyReporters("journeys", {})).toBe("list");
});
