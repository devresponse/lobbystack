import { describe, expect, it } from "vitest";

import { FILE_LINES, FUNCTION_LINES, budgetFrom, ceilingFor, compare, longFunctions, lowered, measure, readBudget, repositoryRoot } from "./module-size";

describe("the size budget", () => {
  it("rounds a ceiling up to the next step, so a one-line fix is not a failing build", () => {
    expect(ceilingFor(789)).toBe(800);
    expect(ceilingFor(800)).toBe(800);
    expect(ceilingFor(801)).toBe(825);
  });

  it("finds a long function by the name it is given, however it is written", () => {
    const body = `${"  const x = 1;\n".repeat(FUNCTION_LINES)}`;
    const source = `
      function declared() {\n${body}      }
      const assigned = () => {\n${body}      };
      const object = { property: function () {\n${body}      } };
      const short = () => 1;
    `;
    expect(Object.keys(longFunctions(source, "source.ts")).sort()).toEqual(["assigned", "declared", "property"]);
  });

  it("names an anonymous function by where it falls, so two in one file are two entries", () => {
    const body = `${"  const x = 1;\n".repeat(FUNCTION_LINES)}`;
    const source = `run(() => {\n${body}});\nrun(() => {\n${body}});\n`;
    expect(Object.keys(longFunctions(source, "source.ts"))).toEqual(["(anonymous 1)", "(anonymous 2)"]);
  });

  it("refuses something new over the budget, and growth past a ceiling", () => {
    const budget = { files: { "a.ts": 900 }, functions: {} };
    expect(compare({ files: { "a.ts": 901 }, functions: {} }, budget)[0]).toContain("past its ceiling of 900");
    expect(compare({ files: { "a.ts": 900, "b.ts": 1000 }, functions: {} }, budget)[0]).toContain(`over the ${FILE_LINES}-line budget`);
  });

  it("asks for the ceiling to come down when a file has shrunk, and for an entry to go when it is gone", () => {
    const budget = { files: { "a.ts": 900 }, functions: {} };
    expect(compare({ files: { "a.ts": 860 }, functions: {} }, budget)[0]).toContain("module-size:update");
    expect(compare({ files: {}, functions: {} }, budget)[0]).toContain("take it off the list");
  });

  it("lowers a ceiling and drops an entry on an update", () => {
    const budget = { files: { "b.ts": 900, "a.ts": 900, "short-again.ts": 825 }, functions: { "a.ts#long": 200 } };
    const update = lowered({ files: { "b.ts": 900, "a.ts": 860 }, functions: { "a.ts#long": 151 } }, budget);
    expect(update).toEqual({ budget: { files: { "a.ts": 875, "b.ts": 900 }, functions: { "a.ts#long": 175 } }, refused: [] });
    expect(Object.keys(update.budget.files)).toEqual(["a.ts", "b.ts"]);
  });

  it("never raises a ceiling or adds an entry on an update, so growth is not one command away", () => {
    const budget = { files: { "a.ts": 900 }, functions: {} };
    const update = lowered({ files: { "a.ts": 901, "new.ts": 1000 }, functions: { "a.ts#grew": 150 } }, budget);
    expect(update.refused).toEqual(["a.ts: 901 lines, past its ceiling of 900.", "new.ts: 1000 lines, and not in the budget.", "a.ts#grew: 150 lines, and not in the budget."]);
    expect(update.budget).toEqual({ files: {}, functions: {} });
  });

  /**
   * AUDIT-013. The ceilings only ever come down. A change that would raise one
   * takes the seam instead: `operations.ts` and `schemas.ts` by v1 resource,
   * `dispatchJob` into a map from job type to handler, billing reconciliation
   * into one handler per event type.
   */
  it("holds the repository to its budget", () => {
    expect(compare(measure(repositoryRoot), readBudget())).toEqual([]);
  });

  it("keeps the budget file as the update script writes it", () => {
    expect(readBudget()).toEqual(budgetFrom(measure(repositoryRoot)));
    expect(lowered(measure(repositoryRoot), readBudget())).toEqual({ budget: readBudget(), refused: [] });
  });
});
