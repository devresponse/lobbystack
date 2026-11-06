import { chunkText } from "./chunkText.ts";
import { countNumbers, impossibleNumbers, numbersIn, subtractCounts, total } from "./numbers.ts";
import type { Truth } from "./truth.ts";

/**
 * The whitespace rule chunkText applies before it cuts: the text the stored chunks hold,
 * without their overlaps. A test checks it against chunkText itself.
 */
export const storedForm = (text: string) => text.replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

export type Chunk = { sequence: number; characters: number; pages: number[]; content: string };

export type Metrics = {
  characters: number;
  lines: number;
  /** Lines where the reader found two or more cells: a tab from pdf-parse, " | " from pdfjs. */
  cellLinesFound: number;
  /** Lines that still show their cells once chunkText has run: tabs turn into spaces, " | " stays. */
  cellLinesStored: number;
  numbers: number;
  /** Digit groups no real number has, such as $25,0002: the design's check F. */
  impossibleNumbers: string[];
  footnoteMarks: number;
  pageMarkers: number;
  chunks: number;
  averageChunkCharacters: number;
  /** Chunks whose first line starts with a number, as a chunk cut inside a table does. */
  chunksStartingWithNumber: number;
};

export type Score = {
  truthFile: string;
  numbersExpected: number;
  numbersFound: number;
  /** Share of the truth's numbers found in the stored text, occurrence by occurrence. */
  numberRecall: number;
  /** Numbers the truth has more often than the stored text, with how many are missing. */
  missing: Record<string, number>;
  /** Numbers the stored text has more often than the truth: misread, fused or added. */
  extra: Record<string, number>;
  rowsExpected: number;
  /** Truth rows whose label and numbers sit on one stored line, the numbers in order. */
  rowsKept: number;
  rowsLost: string[];
};

const pageMarkerLine = /^(?:\[Page (\d+) of \d+(?:, read by OCR)?\]|## Page (\d+) of \d+(?:, read by OCR)?)$/u;

/** The receptionist's chunks, numbered from 0 as stored, with the pages each one covers when the text has page markers. */
export function chunksOf(text: string): Chunk[] {
  const normalized = storedForm(text);
  const markers = [...normalized.matchAll(/^(?:\[Page (\d+) of \d+(?:, read by OCR)?\]|## Page (\d+) of \d+(?:, read by OCR)?)$/gmu)].map((match) => ({ at: match.index, page: Number(match[1] ?? match[2]) }));
  let searchFrom = 0;
  return chunkText(text).map((content, sequence) => {
    // Chunks are slices of the normalized text in order, so each is found from where the last one started.
    const at = normalized.indexOf(content, searchFrom);
    if (at >= 0) searchFrom = at + 1;
    const end = at + content.length;
    const before = markers.filter((marker) => marker.at <= at).at(-1);
    const inside = markers.filter((marker) => marker.at > at && marker.at < end).map((marker) => marker.page);
    const pages = at < 0 ? [] : [...new Set([...(before ? [before.page] : []), ...inside])];
    return { sequence, characters: content.length, pages, content };
  });
}

function countLines(text: string, test: (line: string) => boolean): number {
  return text.split("\n").filter(test).length;
}

export function measure(text: string, chunks: readonly Chunk[]): Metrics {
  const stored = storedForm(text);
  return {
    characters: text.length,
    lines: countLines(stored, (line) => line.trim() !== "" && !pageMarkerLine.test(line)),
    cellLinesFound: countLines(text, (line) => /\S[\t ]*\t[\t ]*\S|\S \| \S/u.test(line)),
    cellLinesStored: countLines(stored, (line) => /\S \| \S/u.test(line)),
    numbers: numbersIn(stored).length,
    impossibleNumbers: impossibleNumbers(stored),
    footnoteMarks: (text.match(/\[\^[^\]\s]{1,4}\]/gu) ?? []).length,
    pageMarkers: countLines(stored, (line) => pageMarkerLine.test(line)),
    chunks: chunks.length,
    averageChunkCharacters: chunks.length ? Math.round(chunks.reduce((sum, chunk) => sum + chunk.characters, 0) / chunks.length) : 0,
    chunksStartingWithNumber: chunks.filter((chunk) => /^[($\-−]?\d/u.test(chunk.content.replace(/^(?:\[Page[^\]]*\]|## Page[^\n]*)\s*/u, ""))).length,
  };
}

/** Whether `wanted` appears in `values` in order, other values allowed in between. */
function inOrder(values: readonly string[], wanted: readonly string[]): boolean {
  let next = 0;
  for (const value of values) if (value === wanted[next] && ++next === wanted.length) return true;
  return wanted.length === 0;
}

const plainWords = (text: string) => text.toLowerCase().replace(/[\s|]+/gu, " ").trim();

const top = (counts: ReadonlyMap<string, number>, limit = 40) => Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).slice(0, limit));

/** Scores the text the receptionist would get (the stored form) against the document's correct content. */
export function score(text: string, truth: Truth): Score {
  const stored = storedForm(text);
  const expected = countNumbers(numbersIn(truth.text));
  const found = countNumbers(numbersIn(stored));
  const missing = subtractCounts(expected, found);
  const extra = subtractCounts(found, expected);
  const lines = stored.split("\n").map((line) => ({ words: plainWords(line), numbers: numbersIn(line) }));
  const lost = truth.rows.filter((row) => !lines.some((line) => line.words.includes(plainWords(row.label)) && inOrder(line.numbers, row.numbers)));
  const numbersExpected = total(expected);
  const numbersMatched = numbersExpected - total(missing);
  return {
    truthFile: truth.file,
    numbersExpected,
    numbersFound: numbersMatched,
    numberRecall: numbersExpected ? numbersMatched / numbersExpected : 1,
    missing: top(missing),
    extra: top(extra),
    rowsExpected: truth.rows.length,
    rowsKept: truth.rows.length - lost.length,
    rowsLost: lost.slice(0, 20).map((row) => `${row.label ? `${row.label}: ` : ""}${row.numbers.join(" ")}`),
  };
}

/** Numbers one reader's stored text has more often than another's. */
export function numberDifferences(a: string, b: string): { onlyA: Record<string, number>; onlyB: Record<string, number> } {
  const first = countNumbers(numbersIn(storedForm(a)));
  const second = countNumbers(numbersIn(storedForm(b)));
  return { onlyA: top(subtractCounts(first, second)), onlyB: top(subtractCounts(second, first)) };
}
