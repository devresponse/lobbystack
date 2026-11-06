import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parsers } from "../src/parsers/index.ts";
import { parseAll, type Result } from "../src/run.ts";

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
const options = { limits: { maxHeapMb: 512, timeoutMs: 120_000 }, ocrMaxPages: 50, pageMarkers: "line" as const };
let output = "";
let results: Result[] = [];

const result = (name: string, parser: string) => {
  const found = results.find((entry) => entry.name === name && entry.parser === parser);
  assert.ok(found, `${parser} read ${name}`);
  return found;
};
const text = (name: string, parser: string) => readFile(path.join(output, name, parser, "text.md"), "utf8");

before(async () => {
  output = await mkdtemp(path.join(tmpdir(), "pdf-parsing-"));
  // The digital fixtures only: the scanned one needs tesseract.js's language files (see ocr.test.ts).
  const digital = await mkdtemp(path.join(tmpdir(), "pdf-parsing-in-"));
  const { copyFile, readdir } = await import("node:fs/promises");
  for (const file of await readdir(fixtures)) if (!file.startsWith("budget-scan")) await copyFile(path.join(fixtures, file), path.join(digital, file));
  results = await parseAll({ input: digital, output, parsers: [...parsers.values()], options, truthFolder: digital, recursive: false, log: () => undefined });
  await rm(digital, { recursive: true, force: true });
});

after(async () => {
  if (output) await rm(output, { recursive: true, force: true });
});

test("each document gets its own folder, with one folder per reader", () => {
  assert.equal(results.length, 10);
  for (const entry of results) {
    assert.equal(entry.error, null, `${entry.parser} read ${entry.name}`);
    for (const file of ["text.md", "chunks.json", "chunks.md", "result.json"]) assert.ok(existsSync(path.join(output, entry.name, entry.parser, file)), `${entry.name}/${entry.parser}/${file}`);
  }
});

test("the current reader gives today's text: footnote marks fused, no page markers", async () => {
  const notes = await text("notes", "current");
  assert.match(notes, /\$25,0002/u);
  assert.match(notes, /10%4/u);
  assert.deepEqual(result("notes", "current").metrics.impossibleNumbers, ["$25,0002", "$50,0003", "10%4"]);
  assert.equal(result("fees", "current").metrics.cellLinesStored, 0);
  assert.doesNotMatch(await text("fees", "current"), /\[Page/u);
});

test("the pdfjs reader splits footnote marks, keeps cells and marks pages", async () => {
  assert.match(await text("notes", "pdfjs"), /Building deductible \| \$25,000 \[\^2\]/u);
  assert.deepEqual(result("notes", "pdfjs").metrics.impossibleNumbers, []);
  const fees = await text("fees", "pdfjs");
  assert.match(fees, /^\[Page 1 of 2\]$/mu);
  assert.match(fees, /^\[Page 2 of 2\]$/mu);
  assert.match(fees, /^44 \| 604 \| 103 \| \$631\.88 \| \$228\.25 \| \$860\.13$/mu);
  const chunks = JSON.parse(await readFile(path.join(output, "fees", "pdfjs", "chunks.json"), "utf8")) as Array<{ pages: number[] }>;
  assert.deepEqual(chunks.map((chunk) => chunk.pages), [[1], [1, 2]]);
});

test("scores both readers against the truth files", () => {
  assert.equal(result("fees", "current").score?.rowsKept, 1);
  assert.equal(result("fees", "pdfjs").score?.rowsKept, result("fees", "pdfjs").score?.rowsExpected);
  assert.equal(result("notes", "current").score?.numberRecall.toFixed(2), "0.67");
  assert.equal(result("notes", "pdfjs").score?.numberRecall, 1);
  assert.deepEqual(result("budget", "current").score?.rowsLost, ["Insurance premium: 96000 104212 118500 23.4%"]);
  assert.deepEqual(result("budget", "pdfjs").score?.rowsLost, []);
});

test("the minutes' two columns stay in reading order", async () => {
  const minutes = await text("minutes", "pdfjs");
  const order = ["1. Call to order", "2. Approval", "3. Depreciation", "4. Special levy", "5. Election", "6. Adjournment"].map((heading) => minutes.indexOf(heading));
  assert.ok(order.every((at) => at >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});
