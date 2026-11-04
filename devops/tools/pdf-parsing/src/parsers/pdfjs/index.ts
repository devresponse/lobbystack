import type { Parser } from "../types.ts";
import { extractWithPdfjsInThread } from "./extract.ts";

/** The design's repaired reader: pdfjs-dist's text items laid out by position, with page markers and OCR per page. */
export const pdfjsParser: Parser = {
  name: "pdfjs",
  summary: "pdfjs-dist 6.4 read by position: cells split by \" | \", footnote marks as [^n], a marker on each page, and OCR for every page without text.",
  async parse(input, options) {
    return await extractWithPdfjsInThread(input, { ocrMaxPages: options.ocrMaxPages, pageMarkers: options.pageMarkers }, options.limits);
  },
};
