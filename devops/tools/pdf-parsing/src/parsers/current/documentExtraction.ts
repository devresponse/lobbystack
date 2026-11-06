import { createRequire } from "node:module";
import path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { inflateRawSync } from "node:zlib";

const textMimeTypes = new Set(["text/plain", "text/markdown", "text/x-markdown"]);
const maxOcrPdfPages = 25;
const ocrLanguages = ["eng", "fra"] as const;
// Uploads are at most 25 MB, so only a compressed file can unpack to more text than this.
const maxExtractedTextLength = 25 * 1024 * 1024;
const maxInflatedDocxBytes = 256 * 1024 * 1024;

/**
 * Inflates every .docx entry with a cap before mammoth runs, because JSZip
 * inflates into ArrayBuffers that the thread's heap limit does not cover.
 * Finds entries the way JSZip does, so a crafted archive can't show this check
 * different data than JSZip later reads.
 */
export function assertDocxInflatesWithin(body: Uint8Array, limit = maxInflatedDocxBytes): void {
  const zip = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const end = zip.lastIndexOf(Buffer.from("PK\x05\x06", "latin1"));
  // Not a zip, or a truncated one: JSZip rejects it before inflating anything.
  if (end < 0 || end + 22 > zip.length) return;
  // JSZip would read ZIP64 records instead of these fields, and no 25 MB .docx needs them.
  if ([4, 6, 8, 10].some((at) => zip.readUInt16LE(end + at) === 0xffff) || [12, 16].some((at) => zip.readUInt32LE(end + at) === 0xffffffff)) throw new Error("ZIP64 .docx files are not supported.");
  // Bytes in front of the archive shift every offset, as in JSZip.
  const prefix = end - zip.readUInt32LE(end + 12) - zip.readUInt32LE(end + 16);
  if (prefix < 0) return;
  let inflated = 0;
  // JSZip reads every consecutive directory entry, whatever count the end record gives.
  for (let entry = prefix + zip.readUInt32LE(end + 16); entry + 46 <= zip.length && zip.readUInt32LE(entry) === 0x02014b50; entry += 46 + zip.readUInt16LE(entry + 28) + zip.readUInt16LE(entry + 30) + zip.readUInt16LE(entry + 32)) {
    if (zip.readUInt16LE(entry + 10) !== 8) continue;
    const local = prefix + zip.readUInt32LE(entry + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    try {
      inflated += inflateRawSync(zip.subarray(start, start + zip.readUInt32LE(entry + 20)), { maxOutputLength: Math.max(1, limit - inflated) }).length;
    } catch (error) {
      // A damaged or empty entry fails in JSZip too, so only the size cap rejects the file here.
      if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new Error(`The .docx unpacks to more than ${limit} bytes.`);
    }
  }
}

export type DocumentInput = { body: Uint8Array; contentType: string };
export type OcrRecorder = (durationMs: number, attributes: { source_type: string; page_count?: number }) => void;
type ThreadMessage = { ocr: Parameters<OcrRecorder> } | { text: string } | { pdfReaderFailed: string };

/**
 * The original reader: pdf-parse's text, and OCR only when no page has text.
 * extractPdfText falls back to it, and KNOWLEDGE_PDF_READER=original picks it.
 */
export async function extractPdfTextDefault(body: Uint8Array, recordOcr: OcrRecorder): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: body });
  try {
    // The default joiner adds "-- 1 of 12 --" markers, which would hide a scan's missing text layer.
    const result = await parser.getText({ pageJoiner: "" });
    if (result.text.trim()) return result.text;
    if (result.total > maxOcrPdfPages) {
      throw new Error(`Scanned PDF OCR is limited to ${maxOcrPdfPages} pages.`);
    }

    const ocrStartedAt = performance.now();
    const screenshots = await parser.getScreenshot({ imageBuffer: true, imageDataUrl: false, scale: 2 });
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker([...ocrLanguages]);
    try {
      const pages: string[] = [];
      for (const page of screenshots.pages) {
        const text = (await worker.recognize(Buffer.from(page.data))).data.text.trim();
        if (text) pages.push(text);
      }
      return pages.join("\n\n");
    } finally {
      await worker.terminate();
      recordOcr(performance.now() - ocrStartedAt, { source_type: "pdf", page_count: screenshots.pages.length });
    }
  } finally {
    await parser.destroy();
  }
}

/** A piece of a page's text in PDF units: x from the left, y its baseline from the bottom, height the font size. */
export type PdfTextItem = { str: string; x: number; y: number; width: number; height: number };
type PdfLine = { items: PdfTextItem[]; bottom: number; top: number; height: number };
type OcrBox = { x0: number; y0: number; x1: number; y1: number };
type OcrBlocks = { blocks: Array<{ paragraphs: Array<{ lines: Array<{ words: Array<{ text: string; bbox: OcrBox }>; baseline: OcrBox }> }> }> | null };

// A gap wider than this, in PDF units, starts a new cell. pdf-parse puts its tab at the same 7.
const pdfCellGap = 7;
// Text may join one of the last 3 lines, so a value drawn after its label's second line still lands on
// the label's first line, while a second column, drawn once the first is done, never joins it.
const pdfLineLookback = 3;
// chunkText keeps " | " between cells, where it turns pdf-parse's tabs into spaces.
const pdfCellSeparator = " | ";
// Footnote marks: one or two digits, or the usual symbols.
const pdfFootnoteMark = /^(?:\d{1,2}|[*†‡§¶])$/u;
const pdfOcrScale = 2;

const pdfItemHeight = (item: PdfTextItem) => Math.max(item.height, 0.5);

function groupPdfLines(items: readonly PdfTextItem[]): PdfLine[] {
  const lines: PdfLine[] = [];
  for (const item of items) {
    let best: PdfLine | undefined;
    let bestOverlap = 0.5;
    for (const line of lines.slice(-pdfLineLookback)) {
      // How much of the smaller of the two boxes the other covers vertically, from 0 to 1.
      const overlap = (Math.min(item.y + pdfItemHeight(item), line.top) - Math.max(item.y, line.bottom)) / Math.min(pdfItemHeight(item), line.top - line.bottom);
      if (overlap >= bestOverlap) {
        best = line;
        bestOverlap = overlap;
      }
    }
    if (best) {
      best.items.push(item);
      best.bottom = Math.min(best.bottom, item.y);
      best.top = Math.max(best.top, item.y + pdfItemHeight(item));
      best.height = Math.max(best.height, pdfItemHeight(item));
    } else {
      lines.push({ items: [item], bottom: item.y, top: item.y + pdfItemHeight(item), height: pdfItemHeight(item) });
    }
  }
  return lines;
}

/** A short mark set smaller than the text beside it and raised above its baseline. */
function isPdfFootnoteMark(item: PdfTextItem, beside: PdfTextItem | undefined): boolean {
  if (!beside || !pdfFootnoteMark.test(item.str.trim())) return false;
  return pdfItemHeight(item) <= pdfItemHeight(beside) * 0.9 && item.y - beside.y >= pdfItemHeight(beside) * 0.25;
}

function renderPdfLine(line: PdfLine): string {
  const items = [...line.items].sort((a, b) => a.x - b.x);
  const cells: string[] = [];
  let cell = "";
  let previous: PdfTextItem | undefined;
  let previousWasMark = false;
  items.forEach((item, index) => {
    const beside = previous && !previousWasMark ? previous : items[index + 1];
    if (isPdfFootnoteMark(item, beside)) {
      const mark = `[^${item.str.trim()}]`;
      // A mark that opens its line starts the footnote's own text, as Markdown writes it.
      cell = cells.length === 0 && cell === "" ? `${mark}:` : `${cell.trimEnd()} ${mark}`;
      previous = item;
      previousWasMark = true;
      return;
    }
    const text = item.str.replace(/\s+/gu, " ");
    if (previous) {
      const gap = item.x - (previous.x + previous.width);
      if (gap > pdfCellGap) {
        cells.push(cell.trim());
        cell = "";
      } else if ((gap > Math.min(pdfItemHeight(item), pdfItemHeight(previous)) * 0.15 || previousWasMark) && !cell.endsWith(" ") && !text.startsWith(" ")) {
        cell += " ";
      }
    }
    cell += text;
    previous = item;
    previousWasMark = false;
  });
  cells.push(cell.trim());
  return cells.filter((value) => value !== "").join(pdfCellSeparator);
}

function layoutPdfLines(lines: readonly PdfLine[]): string {
  const out: string[] = [];
  let previous: PdfLine | undefined;
  for (const line of lines) {
    const text = renderPdfLine(line);
    if (!text) continue;
    // A blank line where the text jumps up (a new column) or leaves more than a line's gap (a new paragraph).
    if (previous && (line.top > previous.bottom + line.height || previous.bottom - line.top > line.height * 0.8)) out.push("");
    out.push(text);
    previous = line;
  }
  return out.join("\n");
}

/**
 * Lays out one page's text in the order the PDF draws it, which keeps a two-column page's
 * columns apart: cells split by a wide gap are written with " | ", a small raised mark as [^n],
 * and a row's values stay on its label's first line when the label wraps.
 */
export function layoutPdfPage(items: readonly PdfTextItem[]): string {
  return layoutPdfLines(groupPdfLines(items.filter((item) => item.str.trim() !== "")));
}

/** Lays out lines already grouped, such as the lines Tesseract finds on a scanned page. */
export function layoutPdfWordLines(wordLines: ReadonlyArray<readonly PdfTextItem[]>): string {
  const lines = wordLines
    .map((words) => words.filter((word) => word.str.trim() !== ""))
    .filter((words) => words.length > 0)
    .map((words): PdfLine => ({
      items: [...words],
      bottom: Math.min(...words.map((word) => word.y)),
      top: Math.max(...words.map((word) => word.y + pdfItemHeight(word))),
      height: Math.max(...words.map(pdfItemHeight)),
    }));
  return layoutPdfLines(lines);
}

/** Tesseract's words in PDF units. A word's bottom is its line's baseline, unless the word sits above it, as a raised mark does. */
function ocrPdfWordLines(page: OcrBlocks, imageHeight: number): PdfTextItem[][] {
  const lines = (page.blocks ?? []).flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines));
  return lines.map((line) => line.words.map((word) => {
    const { x0, y0, x1, y1 } = word.bbox;
    const run = line.baseline.x1 - line.baseline.x0;
    const baseline = run === 0 ? line.baseline.y0 : line.baseline.y0 + ((line.baseline.y1 - line.baseline.y0) * ((x0 + x1) / 2 - line.baseline.x0)) / run;
    return { str: word.text, x: x0 / pdfOcrScale, y: (imageHeight - Math.min(y1, baseline)) / pdfOcrScale, width: (x1 - x0) / pdfOcrScale, height: (y1 - y0) / pdfOcrScale };
  }));
}

/** Both readers refuse a scan longer than OCR reads, so the original isn't asked to read it again. */
class ScannedPdfTooLongError extends Error {}

/**
 * The improved reader couldn't read a PDF, so extractDocumentTextInThread has the original read it in
 * a new thread: pdf.js 6 leaves its worker code and canvas classes on globalThis, where pdf-parse's
 * pdf.js 5 would find them and refuse to run.
 */
class ImprovedPdfReaderError extends Error {}

/**
 * The improved reader: pdfjs-dist's positioned text laid out by layoutPdfPage, a "[Page 2 of 9]"
 * line where each page starts, and OCR for every page without a text layer, not only when no
 * page has text, up to maxOcrPdfPages, as the original.
 */
export async function extractPdfTextImproved(body: Uint8Array, recordOcr: OcrRecorder): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs-dist has no exports map, so its fonts, character maps and decoders resolve from its package.json.
  const folder = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  // pdf.js takes over the buffer it is given, so it gets its own copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(body), standardFontDataUrl: `${folder}/standard_fonts/`, cMapUrl: `${folder}/cmaps/`, cMapPacked: true, iccUrl: `${folder}/iccs/`, wasmUrl: `${folder}/wasm/`, verbosity: 0 });
  try {
    const pdf = await task.promise;
    const pages: Array<{ number: number; text: string; ocr: boolean }> = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      // Marked-content entries carry no text; only items with a string are laid out.
      const items = content.items.flatMap((item) => ("str" in item ? [{ str: item.str, x: item.transform[4] ?? 0, y: item.transform[5] ?? 0, width: item.width, height: item.height }] : []));
      pages.push({ number, text: layoutPdfPage(items), ocr: false });
      page.cleanup();
    }
    const scanned = pages.filter((page) => page.text.trim() === "");
    if (scanned.length === pages.length && pages.length > maxOcrPdfPages) throw new ScannedPdfTooLongError(`Scanned PDF OCR is limited to ${maxOcrPdfPages} pages.`);
    const toRead = scanned.slice(0, maxOcrPdfPages);
    if (toRead.length) {
      const ocrStartedAt = performance.now();
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker([...ocrLanguages]);
      try {
        for (const entry of toRead) {
          const page = await pdf.getPage(entry.number);
          const viewport = page.getViewport({ scale: pdfOcrScale });
          const canvasFactory = pdf.canvasFactory as { create(width: number, height: number): { canvas: { toBuffer(type: string): Buffer }; context: unknown } };
          const { canvas, context } = canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
          const result = await worker.recognize(canvas.toBuffer("image/png"), {}, { text: true, blocks: true });
          entry.text = layoutPdfWordLines(ocrPdfWordLines(result.data as unknown as OcrBlocks, Math.ceil(viewport.height)));
          entry.ocr = true;
          page.cleanup();
        }
      } finally {
        await worker.terminate();
        recordOcr(performance.now() - ocrStartedAt, { source_type: "pdf", page_count: toRead.length });
      }
    }
    return pages
      .filter((page) => page.text.trim() !== "")
      .map((page) => `[Page ${page.number} of ${pages.length}${page.ocr ? ", read by OCR" : ""}]\n${page.text}`)
      .join("\n\n");
  } finally {
    await task.destroy();
  }
}

/**
 * Reads a PDF with the improved reader, unless KNOWLEDGE_PDF_READER is "original" (or "default").
 * When the improved reader fails, extractDocumentTextInThread has the original read the PDF in a new
 * thread, so a PDF the improved reader can't read is no worse off than before.
 */
async function extractPdfText(body: Uint8Array, recordOcr: OcrRecorder): Promise<string> {
  if (["original", "default"].includes(process.env.KNOWLEDGE_PDF_READER?.trim().toLowerCase() ?? "")) return await extractPdfTextDefault(body, recordOcr);
  try {
    return await extractPdfTextImproved(body, recordOcr);
  } catch (error) {
    if (error instanceof ScannedPdfTooLongError) throw error;
    throw new ImprovedPdfReaderError((error instanceof Error ? error.message : String(error)).slice(0, 500), { cause: error });
  }
}

export async function extractDocumentText(input: DocumentInput, recordOcr: OcrRecorder = () => undefined): Promise<string> {
  const contentType = input.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (textMimeTypes.has(contentType)) return new TextDecoder().decode(input.body);
  if (contentType === "application/pdf") return await extractPdfText(input.body, recordOcr);
  if (contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    assertDocxInflatesWithin(input.body);
    const { default: mammoth } = await import("mammoth");
    return (await mammoth.extractRawText({ buffer: Buffer.from(input.body) })).value ?? "";
  }
  if (contentType.startsWith("image/")) {
    const ocrStartedAt = performance.now();
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker([...ocrLanguages]);
    try {
      return (await worker.recognize(Buffer.from(input.body))).data.text;
    } finally {
      await worker.terminate();
      recordOcr(performance.now() - ocrStartedAt, { source_type: "image" });
    }
  }
  throw new Error(`Unsupported knowledge document content type: ${contentType || "unknown"}.`);
}

/**
 * Extracts text in a worker thread with its own heap limit and deadline, so a
 * crafted file that exhausts the parser's heap kills only this thread, not the
 * process that also runs live calls and every other job.
 * shortcut: the limit covers the V8 heap, not ArrayBuffers. .docx entries are
 * capped above, but a PDF's compressed streams are not; run extraction in a
 * child process with a memory limit if PDF bombs become a real threat.
 */
export async function extractDocumentTextInThread(input: DocumentInput, recordOcr: OcrRecorder, limits = { maxHeapMb: 512, timeoutMs: 5 * 60_000 }): Promise<string> {
  try {
    return await extractInThread(input, recordOcr, limits, process.env);
  } catch (error) {
    if (!(error instanceof ImprovedPdfReaderError)) throw error;
    console.warn(JSON.stringify({ event: "knowledge.pdf_reader_fallback", message: error.message }));
    return await extractInThread(input, recordOcr, limits, { ...process.env, KNOWLEDGE_PDF_READER: "original" });
  }
}

async function extractInThread(input: DocumentInput, recordOcr: OcrRecorder, limits: { maxHeapMb: number; timeoutMs: number }, env: NodeJS.ProcessEnv): Promise<string> {
  // The build emits this module as its own entry beside index.js; dev and tests load the .ts source.
  const thread = new Worker(new URL(`./documentExtraction.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url), {
    workerData: { documentExtraction: input },
    resourceLimits: { maxOldGenerationSizeMb: limits.maxHeapMb },
    env,
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Document extraction timed out after ${limits.timeoutMs} ms.`)), limits.timeoutMs);
      thread.on("message", (message: ThreadMessage) => {
        if ("ocr" in message) recordOcr(...message.ocr);
        else if ("pdfReaderFailed" in message) reject(new ImprovedPdfReaderError(message.pdfReaderFailed));
        else resolve(message.text);
      });
      thread.on("error", reject);
      thread.on("exit", (code) => reject(new Error(`Document extraction thread exited with code ${code}.`)));
    });
  } finally {
    clearTimeout(timer);
    await thread.terminate();
  }
}

if (!isMainThread && workerData?.documentExtraction) {
  const post = (message: ThreadMessage) => parentPort?.postMessage(message);
  try {
    const text = await extractDocumentText(workerData.documentExtraction, (...ocr) => post({ ocr }));
    if (text.length > maxExtractedTextLength) throw new Error(`Extracted text is longer than ${maxExtractedTextLength} characters.`);
    post({ text });
  } catch (error) {
    if (!(error instanceof ImprovedPdfReaderError)) throw error;
    post({ pdfReaderFailed: error.message });
  }
}
