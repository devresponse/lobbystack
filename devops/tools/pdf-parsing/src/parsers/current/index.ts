import type { OcrRun, Parser } from "../types.ts";
// A byte-for-byte copy of apps/worker/src/documentExtraction.ts: never edit it here.
// `npm run check-copy` compares it with the worker's file, and `-- --fix` copies it again.
import { extractDocumentTextInThread } from "./documentExtraction.ts";

/**
 * Today's reader, called the way the worker's knowledge.extractDocument job calls it
 * (apps/worker/src/handlers.ts): in its own thread, with the same heap cap and deadline.
 */
export const currentParser: Parser = {
  name: "current",
  summary: "Today's worker reader, copied byte for byte: pdf-parse 2.4.5, OCR with tesseract.js only when no page has text, 10 pages at most.",
  async parse(input, options) {
    const ocr: OcrRun[] = [];
    const text = await extractDocumentTextInThread(input, (durationMs, attributes) => {
      ocr.push({ durationMs, sourceType: attributes.source_type, ...(attributes.page_count === undefined ? {} : { pageCount: attributes.page_count }) });
    }, options.limits);
    return { text, ocr, notes: [] };
  },
};
