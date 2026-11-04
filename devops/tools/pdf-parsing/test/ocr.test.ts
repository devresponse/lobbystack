import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parsers } from "../src/parsers/index.ts";
import { parseAll } from "../src/run.ts";

// tesseract.js reads its eng and fra language files from the working folder and downloads them
// from jsDelivr the first time. The test runs when they are cached, as a first parse leaves them,
// or when PDF_PARSING_OCR_TESTS=1 allows the download.
const cache = fileURLToPath(new URL("../.cache/tesseract", import.meta.url));
const cached = ["eng", "fra"].every((language) => existsSync(path.join(cache, `${language}.traineddata`)));
const skip = cached || process.env.PDF_PARSING_OCR_TESTS === "1" ? false : "no cached OCR language files; set PDF_PARSING_OCR_TESTS=1 to download them";

test("both readers OCR a scanned page, and pdfjs keeps its cells", { skip, timeout: 240_000 }, async () => {
  await mkdir(cache, { recursive: true });
  process.chdir(cache);
  const input = await mkdtemp(path.join(tmpdir(), "pdf-parsing-scan-"));
  const output = await mkdtemp(path.join(tmpdir(), "pdf-parsing-out-"));
  try {
    const { copyFile } = await import("node:fs/promises");
    for (const file of ["budget-scan.pdf", "budget-scan.html"]) await copyFile(fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url)), path.join(input, file));
    const results = await parseAll({ input, output, parsers: [...parsers.values()], options: { limits: { maxHeapMb: 512, timeoutMs: 180_000 }, ocrMaxPages: 50, pageMarkers: "line" }, truthFolder: input, recursive: false, log: () => undefined });
    for (const result of results) {
      assert.equal(result.error, null, result.parser);
      assert.equal(result.ocr[0]?.pageCount, 1, result.parser);
      assert.ok((result.score?.numberRecall ?? 0) > 0.8, `${result.parser} found most numbers`);
    }
    const pdfjs = await readFile(path.join(output, "budget-scan", "pdfjs", "text.md"), "utf8");
    assert.match(pdfjs, /^\[Page 1 of 1, read by OCR\]$/mu);
    assert.match(pdfjs, /^Management fees \| 38,400 \| 38,400 \| 39,550 \| 3\.0%$/mu);
  } finally {
    await rm(input, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});
