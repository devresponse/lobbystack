import { createRequire } from "node:module";
import path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import type { OcrRun, PageMarkers, ParsedPage, ParseInput, ParseLimits, ParseOutput } from "../types.ts";
import { layoutPage, layoutWordLines, type TextItem } from "./layout.ts";

// The same languages and render scale as the worker's OCR, so OCR results compare like for like.
const ocrLanguages = ["eng", "fra"];
const ocrScale = 2;
// pdfjs-dist has no exports map, so its folder (fonts and character maps) resolves from its package.json.
const pdfjsFolder = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

export type PdfjsSettings = { ocrMaxPages: number; pageMarkers: PageMarkers };

type PdfjsTextItem = { str: string; transform: number[]; width: number; height: number };
type Page = ParsedPage & { empty: boolean };
type OcrWord = { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } };
type OcrLine = { words: OcrWord[]; baseline: { x0: number; y0: number; x1: number; y1: number } };
type OcrPage = { blocks: Array<{ paragraphs: Array<{ lines: OcrLine[] }> }> | null };

function toTextItem(item: PdfjsTextItem): TextItem {
  return { str: item.str, x: item.transform[4] ?? 0, y: item.transform[5] ?? 0, width: item.width, height: item.height };
}

/** Tesseract's words in PDF units. A word's bottom is the line's baseline unless the word sits above it, as a raised mark does. */
function ocrLines(page: OcrPage, imageHeight: number): TextItem[][] {
  const lines = (page.blocks ?? []).flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines));
  return lines.map((line) => line.words.map((word) => {
    const { x0, y0, x1, y1 } = word.bbox;
    const middle = (x0 + x1) / 2;
    const run = line.baseline.x1 - line.baseline.x0;
    const baseline = run === 0 ? line.baseline.y0 : line.baseline.y0 + ((line.baseline.y1 - line.baseline.y0) * (middle - line.baseline.x0)) / run;
    return { str: word.text, x: x0 / ocrScale, y: (imageHeight - Math.min(y1, baseline)) / ocrScale, width: (x1 - x0) / ocrScale, height: (y1 - y0) / ocrScale };
  }));
}

function pageHeader(page: Page, total: number, markers: PageMarkers): string {
  if (markers === "none") return "";
  const label = `Page ${page.number} of ${total}${page.ocr ? ", read by OCR" : ""}`;
  return markers === "heading" ? `## ${label}\n\n` : `[${label}]\n`;
}

/**
 * Reads a PDF with pdfjs-dist: each page's text items laid out by position (see layout.ts),
 * a marker where each page starts, and OCR for every page that has no text layer, not only
 * for PDFs where no page has one.
 */
export async function extractWithPdfjs(input: ParseInput, settings: PdfjsSettings): Promise<ParseOutput> {
  const contentType = input.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (contentType !== "application/pdf") throw new Error(`The pdfjs reader reads PDFs only, not ${contentType || "unknown"} files.`);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js takes over the buffer it is given, so it gets its own copy.
  const task = pdfjs.getDocument({
    data: new Uint8Array(input.body),
    // Fonts the PDF doesn't embed, character maps, colour profiles, and the JBIG2 and JPEG 2000 decoders scans need.
    standardFontDataUrl: `${pdfjsFolder}/standard_fonts/`,
    cMapUrl: `${pdfjsFolder}/cmaps/`,
    cMapPacked: true,
    iccUrl: `${pdfjsFolder}/iccs/`,
    wasmUrl: `${pdfjsFolder}/wasm/`,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    const pages: Page[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      // Marked-content entries carry no text; only items with a string are laid out.
      const layout = layoutPage(content.items.flatMap((item) => ("str" in item ? [toTextItem(item)] : [])));
      pages.push({ number, text: layout.text, ocr: false, footnotes: layout.footnotes, cellLines: layout.cellLines, empty: layout.text.trim() === "" });
      page.cleanup();
    }

    const notes: string[] = [];
    const ocr: OcrRun[] = [];
    const scanned = pages.filter((page) => page.empty);
    const toRead = scanned.slice(0, settings.ocrMaxPages);
    if (scanned.length > toRead.length) notes.push(`${scanned.length - toRead.length} of ${scanned.length} pages without a text layer were not read: --ocr-max-pages is ${settings.ocrMaxPages}.`);
    if (toRead.length) {
      const started = performance.now();
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker(ocrLanguages);
      try {
        for (const entry of toRead) {
          const page = await document.getPage(entry.number);
          const viewport = page.getViewport({ scale: ocrScale });
          const canvasFactory = document.canvasFactory as { create(width: number, height: number): { canvas: { toBuffer(type: string): Buffer }; context: unknown } };
          const { canvas, context } = canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
          const result = await worker.recognize(canvas.toBuffer("image/png"), {}, { text: true, blocks: true });
          const layout = layoutWordLines(ocrLines(result.data as unknown as OcrPage, Math.ceil(viewport.height)));
          Object.assign(entry, { text: layout.text, ocr: true, footnotes: layout.footnotes, cellLines: layout.cellLines });
          page.cleanup();
        }
      } finally {
        await worker.terminate();
        ocr.push({ durationMs: performance.now() - started, sourceType: "pdf", pageCount: toRead.length });
      }
    }

    const text = pages
      .filter((page) => page.text.trim() !== "")
      .map((page) => `${pageHeader(page, document.numPages, settings.pageMarkers)}${page.text}`)
      .join("\n\n");
    return { text, pages: pages.map(({ empty: _empty, ...page }) => page), ocr, notes };
  } finally {
    await task.destroy();
  }
}

type ThreadMessage = { output: ParseOutput };

/** Runs extractWithPdfjs in its own thread with the worker's heap cap and deadline, as the current reader runs. */
export async function extractWithPdfjsInThread(input: ParseInput, settings: PdfjsSettings, limits: ParseLimits): Promise<ParseOutput> {
  const thread = new Worker(new URL(import.meta.url), {
    workerData: { pdfjsExtraction: { input, settings } },
    resourceLimits: { maxOldGenerationSizeMb: limits.maxHeapMb },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<ParseOutput>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Document extraction timed out after ${limits.timeoutMs} ms.`)), limits.timeoutMs);
      thread.on("message", (message: ThreadMessage) => resolve(message.output));
      thread.on("error", reject);
      thread.on("exit", (code) => reject(new Error(`Document extraction thread exited with code ${code}.`)));
    });
  } finally {
    clearTimeout(timer);
    await thread.terminate();
  }
}

if (!isMainThread && workerData?.pdfjsExtraction) {
  const { input, settings } = workerData.pdfjsExtraction as { input: ParseInput; settings: PdfjsSettings };
  const output = await extractWithPdfjs(input, settings);
  parentPort?.postMessage({ output } satisfies ThreadMessage);
}
