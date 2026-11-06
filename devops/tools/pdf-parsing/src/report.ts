import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { numberDifferences } from "./metrics.ts";
import { evaluateText, RESULT_FILE, TEXT_FILE, type Result } from "./run.ts";

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** Every result saved under the output folder, sorted by document, then reader. */
export async function readResults(output: string): Promise<Result[]> {
  const results: Result[] = [];
  const documents = await readdir(output, { withFileTypes: true }).catch(() => []);
  for (const document of documents.filter((entry) => entry.isDirectory())) {
    for (const parser of await readdir(path.join(output, document.name), { withFileTypes: true })) {
      if (!parser.isDirectory()) continue;
      const file = path.join(output, document.name, parser.name, RESULT_FILE);
      const content = await readFile(file, "utf8").catch(() => undefined);
      if (content) results.push(JSON.parse(content) as Result);
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name) || a.parser.localeCompare(b.parser));
}

/** Scores every saved text again, against the truth folder given or the one each result used. */
export async function rescore(output: string, results: Result[], truthFolder: string | undefined): Promise<void> {
  for (const result of results) {
    const folder = path.join(output, result.name, result.parser);
    const text = await readFile(path.join(folder, TEXT_FILE), "utf8");
    const { metrics, score } = await evaluateText(text, result.name, truthFolder ?? result.truthFolder);
    Object.assign(result, { metrics, score, ...(truthFolder ? { truthFolder } : {}) });
    await writeFile(path.join(folder, RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`);
  }
}

const columns = ["document", "parser", "pages", "ms", "ocr_pages", "characters", "chunks", "numbers", "impossible_numbers", "footnote_marks", "cell_lines_found", "cell_lines_stored", "chunks_starting_with_number", "number_recall", "numbers_missing", "numbers_extra", "rows_kept", "rows_expected", "error"] as const;

function row(result: Result): Record<(typeof columns)[number], string | number> {
  const { metrics: m, score: s } = result;
  const sum = (values: Record<string, number>) => Object.values(values).reduce((total, count) => total + count, 0);
  return {
    document: result.name,
    parser: result.parser,
    pages: result.pages ?? "",
    ms: result.durationMs,
    ocr_pages: result.ocr.reduce((total, run) => total + (run.pageCount ?? (run.sourceType === "image" ? 1 : 0)), 0),
    characters: m.characters,
    chunks: m.chunks,
    numbers: m.numbers,
    impossible_numbers: m.impossibleNumbers.length,
    footnote_marks: m.footnoteMarks,
    cell_lines_found: m.cellLinesFound,
    cell_lines_stored: m.cellLinesStored,
    chunks_starting_with_number: m.chunksStartingWithNumber,
    number_recall: s ? Number(s.numberRecall.toFixed(3)) : "",
    numbers_missing: s ? sum(s.missing) : "",
    numbers_extra: s ? sum(s.extra) : "",
    rows_kept: s ? s.rowsKept : "",
    rows_expected: s ? s.rowsExpected : "",
    error: result.error ?? "",
  };
}

const csvCell = (value: string | number) => (/[",\n\r]/u.test(String(value)) ? `"${String(value).replace(/"/gu, '""')}"` : String(value));
const mdCell = (value: string | number) => String(value).replace(/\\/gu, "\\\\").replace(/\|/gu, "\\|").replace(/\s+/gu, " ") || "-";
const listed = (values: Record<string, number>) => Object.entries(values).map(([value, count]) => (count > 1 ? `${value} ×${count}` : value)).join(", ") || "none";

function totals(results: readonly Result[]): string[] {
  const byParser = new Map<string, Result[]>();
  for (const result of results) byParser.set(result.parser, [...(byParser.get(result.parser) ?? []), result]);
  const lines = ["| Parser | Documents | Failed | Seconds | Impossible numbers | Lines with cells, stored | Numbers found (truth) | Rows kept whole (truth) |", "|---|---|---|---|---|---|---|---|"];
  for (const [parser, list] of byParser) {
    const scored = list.filter((result) => result.score);
    const expected = scored.reduce((sum, result) => sum + (result.score?.numbersExpected ?? 0), 0);
    const found = scored.reduce((sum, result) => sum + (result.score?.numbersFound ?? 0), 0);
    const rowsExpected = scored.reduce((sum, result) => sum + (result.score?.rowsExpected ?? 0), 0);
    const rowsKept = scored.reduce((sum, result) => sum + (result.score?.rowsKept ?? 0), 0);
    lines.push(`| ${parser} | ${list.length} | ${list.filter((result) => result.error).length} | ${(list.reduce((sum, result) => sum + result.durationMs, 0) / 1000).toFixed(1)} | ${list.reduce((sum, result) => sum + result.metrics.impossibleNumbers.length, 0)} | ${list.reduce((sum, result) => sum + result.metrics.cellLinesStored, 0)} | ${scored.length ? `${found} of ${expected} (${percent(expected ? found / expected : 1)}) in ${scored.length} documents` : "no truth files"} | ${scored.length ? `${rowsKept} of ${rowsExpected}` : "-"} |`);
  }
  return lines;
}

/** Side by side, for one document read by two or more readers. */
async function compareDocument(output: string, list: readonly Result[]): Promise<string> {
  const name = list[0]?.name ?? "";
  const metric = (label: string, value: (result: Result) => string | number) => `| ${label} | ${list.map((result) => mdCell(value(result))).join(" | ")} |`;
  const lines = [
    `# ${name}: ${list.map((result) => result.parser).join(" and ")} compared`,
    "",
    `Read from ${list[0]?.input ?? ""}. Each reader's text is in its folder's ${TEXT_FILE}, and the chunks the receptionist would get are in chunks.md.`,
    "",
    `| | ${list.map((result) => result.parser).join(" | ")} |`,
    `|---|${list.map(() => "---").join("|")}|`,
    metric("Failed", (result) => result.error ?? "no"),
    metric("Milliseconds", (result) => result.durationMs),
    metric("OCR", (result) => (result.ocr.length ? result.ocr.map((run) => `${run.pageCount ?? 1} page(s), ${run.durationMs} ms`).join("; ") : "none")),
    metric("Characters", (result) => result.metrics.characters),
    metric("Chunks", (result) => result.metrics.chunks),
    metric("Numbers", (result) => result.metrics.numbers),
    metric("Impossible numbers", (result) => result.metrics.impossibleNumbers.join(", ") || "none"),
    metric("Footnote marks split off", (result) => result.metrics.footnoteMarks),
    metric("Page markers", (result) => result.metrics.pageMarkers),
    metric("Lines with cells, found", (result) => result.metrics.cellLinesFound),
    metric("Lines with cells, stored", (result) => result.metrics.cellLinesStored),
    metric("Chunks starting with a number", (result) => result.metrics.chunksStartingWithNumber),
  ];
  if (list.some((result) => result.score)) {
    lines.push(
      metric("Numbers found (truth)", (result) => (result.score ? `${result.score.numbersFound} of ${result.score.numbersExpected} (${percent(result.score.numberRecall)})` : "-")),
      metric("Rows kept whole (truth)", (result) => (result.score?.rowsExpected ? `${result.score.rowsKept} of ${result.score.rowsExpected}` : "-")),
      metric("Missing numbers", (result) => (result.score ? listed(result.score.missing) : "-")),
      metric("Extra numbers", (result) => (result.score ? listed(result.score.extra) : "-")),
      metric("Rows not kept whole", (result) => (result.score ? result.score.rowsLost.join("; ") || "none" : "-")),
    );
  }
  const [base, ...others] = list;
  if (base) {
    const baseText = await readFile(path.join(output, name, base.parser, TEXT_FILE), "utf8");
    for (const other of others) {
      const otherText = await readFile(path.join(output, name, other.parser, TEXT_FILE), "utf8");
      const { onlyA, onlyB } = numberDifferences(baseText, otherText);
      lines.push("", `## Numbers that differ: ${base.parser} and ${other.parser}`, "", `Only in ${base.parser}: ${listed(onlyA)}`, "", `Only in ${other.parser}: ${listed(onlyB)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Writes summary.md, summary.csv and summary.json for the whole output folder, and compare.md for each document read more than once. */
export async function writeReport(output: string, results: Result[]): Promise<string> {
  const rows = results.map(row);
  await writeFile(path.join(output, "summary.json"), `${JSON.stringify(rows, null, 2)}\n`);
  await writeFile(path.join(output, "summary.csv"), `${[columns.join(","), ...rows.map((entry) => columns.map((column) => csvCell(entry[column])).join(","))].join("\n")}\n`);
  const byDocument = new Map<string, Result[]>();
  for (const result of results) byDocument.set(result.name, [...(byDocument.get(result.name) ?? []), result]);
  for (const list of byDocument.values()) {
    if (list.length > 1) {
      // The current reader goes first, as the baseline the others are compared with.
      const ordered = [...list].sort((a, b) => Number(b.parser === "current") - Number(a.parser === "current") || a.parser.localeCompare(b.parser));
      await writeFile(path.join(output, ordered[0]?.name ?? "", "compare.md"), await compareDocument(output, ordered));
    }
  }
  const markdown = [
    "# PDF parsing results",
    "",
    `${byDocument.size} document${byDocument.size === 1 ? "" : "s"}, read by ${[...new Set(results.map((result) => result.parser))].join(", ")}. Numbers are counted in the stored text, after chunkText has turned tabs and runs of spaces into one space, so they show what the receptionist gets. The truth columns need a <document>.html, .md or .txt in the truth folder.`,
    "",
    ...totals(results),
    "",
    `| ${columns.join(" | ")} |`,
    `|${columns.map(() => "---").join("|")}|`,
    ...rows.map((entry) => `| ${columns.map((column) => mdCell(entry[column])).join(" | ")} |`),
    "",
  ].join("\n");
  const file = path.join(output, "summary.md");
  await writeFile(file, markdown);
  return file;
}
