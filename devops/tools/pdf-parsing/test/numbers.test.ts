import assert from "node:assert/strict";
import { test } from "node:test";

import { impossibleNumbers, numbersIn } from "../src/numbers.ts";

test("reads numbers in the canonical form the design's checks use", () => {
  assert.deepEqual(numbersIn("Strata fees\t$412,800\t$441,700\t7.0%"), ["412800", "441700", "7.0%"]);
  assert.deepEqual(numbersIn("Cotisations | 412 800 $ | 441 700 $ | 7,0 %"), ["412800", "441700", "7.0%"]);
  assert.deepEqual(numbersIn("Contingency 10,000 (1,250) −1,250 (5.5%) $0 ($0)"), ["10000", "-1250", "-1250", "-5.5%", "0", "0"]);
  assert.deepEqual(numbersIn("7.0% and 7% differ; $1.2 million"), ["7.0%", "7%", "1.2"]);
});

test("keeps cells apart only while a separator shows them", () => {
  // chunkText turns the tabs between these cells into spaces, so they read as one number.
  assert.deepEqual(numbersIn("44 604 103 $631.88"), ["44604103", "631.88"]);
  assert.deepEqual(numbersIn("44 | 604 | 103 | $631.88"), ["44", "604", "103", "631.88"]);
  assert.deepEqual(numbersIn("96,000 104,212"), ["96000", "104212"]);
});

test("leaves out times, page markers and footnote marks", () => {
  assert.deepEqual(numbersIn("[Page 3 of 12]\nCalled to order at 7:04 p.m."), ["7:04"]);
  assert.deepEqual(numbersIn("Building deductible | $25,000 [^2]\n[^2]: Per claim."), ["25000"]);
  assert.deepEqual(numbersIn("## Page 2 of 9, read by OCR\nLot 7"), ["7"]);
});

test("finds the digit groups no real number has", () => {
  assert.deepEqual(impossibleNumbers("Building deductible $25,0002, earthquake 10%4, fine $25,000 and 7.0%"), ["$25,0002", "10%4"]);
  assert.deepEqual(impossibleNumbers("Building deductible | $25,000 [^2]"), []);
});
