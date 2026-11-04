import type { OcrRun, Parser } from "../types.ts";
// A byte-for-byte copy of apps/worker/src/documentExtraction.ts: never edit it here.
// `npm run check-copy` compares it with the worker's file, and `-- --fix` copies it again.
import { extractDocumentTextInThread } from "./documentExtraction.ts";

/**
 * The worker's original reader, extractPdfTextDefault, called the way the worker's
 * knowledge.extractDocument job calls it (apps/worker/src/handlers.ts): in its own thread, with
 * the same heap cap and deadline. The worker reads with it when KNOWLEDGE_PDF_READER is original;
 * by default it reads with the improved reader, the same as the pdfjs parser here.
 */
export const currentParser: Parser = {
  name: "current",
  summary: "The worker's original reader, copied byte for byte: pdf-parse 2.4.5, OCR with tesseract.js only when no page has text, 25 pages at most.",
  async parse(input, options) {
    // The thread starts with a copy of this process's variables, so this picks the original reader in it.
    process.env.KNOWLEDGE_PDF_READER = "original";
    const ocr: OcrRun[] = [];
    const text = await extractDocumentTextInThread(input, (durationMs, attributes) => {
      ocr.push({ durationMs, sourceType: attributes.source_type, ...(attributes.page_count === undefined ? {} : { pageCount: attributes.page_count }) });
    }, options.limits);
    return { text, ocr, notes: [] };
  },
};
