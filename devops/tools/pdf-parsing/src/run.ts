import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { listPdfs } from "./files.ts";
import { chunksOf, measure, score, type Chunk, type Metrics, type Score } from "./metrics.ts";
import type { OcrRun, ParsedPage, Parser, ParseOptions } from "./parsers/types.ts";
import { loadTruth } from "./truth.ts";

export const RESULT_FILE = "result.json";
export const TEXT_FILE = "text.md";

/** What one reader made of one PDF, as saved in <output>/<name>/<parser>/result.json. */
export type Result = {
  tool: string;
  parser: string;
  parserSummary: string;
  name: string;
  input: string;
  inputBytes: number;
  inputSha256: string;
  pages: number | null;
  parsedAt: string;
  durationMs: number;
  ocr: OcrRun[];
  notes: string[];
  error: string | null;
  settings: ParseOptions;
  truthFolder: string;
  metrics: Metrics;
  score: Score | null;
};

export const toolVersion = "lobbystack-pdf-parsing 0.1.0";

/** Pages in the PDF, counted with pdfjs-dist outside the reader so every reader's row shows the same count. */
async function countPages(body: Uint8Array): Promise<number | null> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: new Uint8Array(body), verbosity: 0 });
    try {
      return (await task.promise).numPages;
    } finally {
      await task.destroy();
    }
  } catch {
    return null;
  }
}

function chunksMarkdown(name: string, parser: string, chunks: readonly Chunk[]): string {
  const parts = chunks.map((chunk) => `--- chunk ${chunk.sequence + 1} of ${chunks.length} (sequence ${chunk.sequence}): ${chunk.characters} characters${chunk.pages.length ? `, ${chunk.pages.length === 1 ? "page" : "pages"} ${chunk.pages.join(", ")}` : ""} ---\n\n${chunk.content}`);
  return `# ${name}: the chunks ${parser} would store\n\nchunkText, copied from the repository, cut the text into ${chunks.length} chunk${chunks.length === 1 ? "" : "s"}. Each is what the receptionist's search can hand over.\n\n${parts.join("\n\n")}\n`;
}

/** Recomputes the metrics and, when a truth file is found, the score, from a result's saved text. */
export async function evaluateText(text: string, name: string, truthFolder: string): Promise<{ chunks: Chunk[]; metrics: Metrics; score: Score | null }> {
  const chunks = chunksOf(text);
  const truth = await loadTruth(truthFolder, name);
  return { chunks, metrics: measure(text, chunks), score: truth ? score(text, truth) : null };
}

export type ParseRun = { input: string; output: string; parsers: Parser[]; options: ParseOptions; truthFolder: string; recursive: boolean; log(line: string): void };

/** Reads every PDF with every reader and saves each result in its own folder. */
export async function parseAll(run: ParseRun): Promise<Result[]> {
  const files = await listPdfs(run.input, run.recursive);
  if (files.length === 0) throw new Error(`There's no PDF in ${run.input}.`);
  const results: Result[] = [];
  for (const file of files) {
    const body = new Uint8Array(await readFile(file.path));
    const pages = await countPages(body);
    for (const parser of run.parsers) {
      const folder = path.join(run.output, file.name, parser.name);
      await mkdir(folder, { recursive: true });
      const started = performance.now();
      let text = "";
      let ocr: OcrRun[] = [];
      let notes: string[] = [];
      let parsedPages: ParsedPage[] | undefined;
      let error: string | null = null;
      try {
        const parsed = await parser.parse({ body: new Uint8Array(body), contentType: "application/pdf" }, run.options);
        ({ text, ocr, notes } = parsed);
        parsedPages = parsed.pages;
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      }
      const durationMs = Math.round(performance.now() - started);
      const { chunks, metrics, score: truthScore } = await evaluateText(text, file.name, run.truthFolder);
      const result: Result = {
        tool: toolVersion,
        parser: parser.name,
        parserSummary: parser.summary,
        name: file.name,
        input: file.path,
        inputBytes: body.byteLength,
        inputSha256: createHash("sha256").update(body).digest("hex"),
        pages,
        parsedAt: new Date().toISOString(),
        durationMs,
        ocr: ocr.map((entry) => ({ ...entry, durationMs: Math.round(entry.durationMs) })),
        notes,
        error,
        settings: run.options,
        truthFolder: run.truthFolder,
        metrics,
        score: truthScore,
      };
      await writeFile(path.join(folder, TEXT_FILE), text);
      await writeFile(path.join(folder, "chunks.json"), `${JSON.stringify(chunks, null, 2)}\n`);
      await writeFile(path.join(folder, "chunks.md"), chunksMarkdown(file.name, parser.name, chunks));
      if (parsedPages) await writeFile(path.join(folder, "pages.json"), `${JSON.stringify(parsedPages, null, 2)}\n`);
      await writeFile(path.join(folder, RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`);
      results.push(result);
      const rows = truthScore?.rowsExpected ? `, ${truthScore.rowsKept} of ${truthScore.rowsExpected} rows whole` : "";
      const recall = truthScore ? `, ${Math.round(truthScore.numberRecall * 100)}% of the numbers${rows}` : "";
      run.log(error ? `${file.relative}  ${parser.name}  failed after ${durationMs} ms: ${error}` : `${file.relative}  ${parser.name}  ${durationMs} ms, ${metrics.characters} characters, ${metrics.chunks} chunks${ocr.length ? ", OCR" : ""}${recall}`);
    }
  }
  return results;
}
