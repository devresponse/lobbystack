import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { score } from "../src/metrics.ts";
import { htmlTruth, textTruth } from "../src/truth.ts";

const budget = htmlTruth(readFileSync(new URL("./fixtures/budget.html", import.meta.url), "utf8"));

test("reads an HTML truth file's text, rows and footnote marks", () => {
  assert.equal(budget.footnoteMarks, 2);
  assert.match(budget.text, /^Strata fees \| \$412,800 \| \$412,800 \| \$441,700 \| 7\.0%$/mu);
  assert.match(budget.text, /^The 2026 premium includes a \$25,000 deductible/mu);
  assert.doesNotMatch(budget.text, /\b1 The 2026/u);
  assert.deepEqual(budget.rows.find((row) => row.label === "Insurance premium"), { label: "Insurance premium", numbers: ["96000", "104212", "118500", "23.4%"] });
});

test("a row counts as whole only when its label and numbers share a line", () => {
  const split = score("Insurance premium (building, liability, and directors' and officers'\ncoverage)1\n96,000 104,212 118,500 23.4%", { ...budget, rows: budget.rows.filter((row) => row.label === "Insurance premium") });
  assert.equal(split.rowsKept, 0);
  const whole = score("Insurance premium (building, liability, and directors' and officers' | 96,000 | 104,212 | 118,500 | 23.4%\ncoverage) [^1]", { ...budget, rows: budget.rows.filter((row) => row.label === "Insurance premium") });
  assert.equal(whole.rowsKept, 1);
});

test("counts missing and extra numbers occurrence by occurrence", () => {
  const truth = textTruth("| Lot | Fee |\n|---|---|\n| 44 | $631.88 |\nDeductible $25,000 [^2]");
  assert.deepEqual(truth.rows, [{ label: "", numbers: ["44", "631.88"] }]);
  const result = score("44 $631.88\nDeductible $25,0002", truth);
  assert.equal(result.numbersExpected, 3);
  assert.equal(result.numbersFound, 2);
  assert.deepEqual(result.missing, { "25000": 1 });
  assert.deepEqual(result.extra, { "25.0002": 1 });
});
