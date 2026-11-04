/** One file to read, as the worker gets it from storage: its bytes and content type. */
export type ParseInput = { body: Uint8Array; contentType: string };

/** The worker's own limits for one extraction thread: a heap cap and a deadline. */
export type ParseLimits = { maxHeapMb: number; timeoutMs: number };

/** How the pdfjs reader marks where each page starts. */
export type PageMarkers = "line" | "heading" | "none";

export type ParseOptions = {
  limits: ParseLimits;
  /** Pages without a text layer that the pdfjs reader reads with OCR; the rest are left out with a note. */
  ocrMaxPages: number;
  pageMarkers: PageMarkers;
};

/** One OCR run, as the worker's recordOcr callback reports it. */
export type OcrRun = { durationMs: number; sourceType: string; pageCount?: number };

/** A page's text, for readers that know where pages start. */
export type ParsedPage = { number: number; text: string; ocr: boolean; footnotes: number; cellLines: number };

export type ParseOutput = {
  /** Exactly what the reader returns: the string the worker hands to chunkText. */
  text: string;
  pages?: ParsedPage[];
  ocr: OcrRun[];
  /** Anything a person reading the result should know, such as pages left out. */
  notes: string[];
};

export type Parser = {
  name: string;
  summary: string;
  parse(input: ParseInput, options: ParseOptions): Promise<ParseOutput>;
};
