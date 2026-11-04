/**
 * Numbers in one canonical form, as the design's number checks compare them:
 * "$412,800" and "412 800 $" are both 412800, "(1,250)" and "−1,250" are both -1250,
 * "7,0 %" is 7.0%, and decimals stay as written, so 7.0% and 7% differ. A number keeps
 * one kind of group separator, so "96,000 104,212" stays two numbers, while "44 604 103"
 * (three cells once chunkText has turned their tabs into spaces) reads as one.
 */

// Spaces PDFs put inside numbers, and the minus signs they use.
const spaces = /[     ]/gu;
const minus = /[−–]/gu;

// Page markers the pdfjs reader adds and footnote marks: never numbers in the document.
const pageMarker = /^(?:\[Page \d+ of \d+(?:, read by OCR)?\]|## Page \d+ of \d+(?:, read by OCR)?)$/gmu;
const footnoteMark = /\[\^[^\]\s]{1,4}\]:?/gu;

const numberPattern = new RegExp(
  [
    String.raw`(?<![\p{L}\p{N}_.,])`, // not inside a word or another number
    String.raw`(?<open>\()?`,
    String.raw`(?<sign>-)?`,
    String.raw`(?:\$ ?)?`,
    String.raw`(?<digits>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,3}(?: \d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)`,
    String.raw`(?![\p{N}])`,
    String.raw`(?: ?%(?<percent>))?`,
    String.raw`(?: ?\$)?`,
    String.raw`(?<close>\))?`,
  ].join(""),
  "gu",
);

const time = /(?<![\p{N}])\d{1,2}:\d{2}(?![\p{N}])/gu;

/** Text as the scorer reads it: page markers and footnote marks left out, odd spaces and minus signs made plain. */
export function scoringText(text: string): string {
  return text.replace(pageMarker, "").replace(footnoteMark, " ").replace(spaces, " ").replace(minus, "-");
}

function canonical(match: RegExpExecArray): string {
  const groups = match.groups ?? {};
  let digits = groups.digits ?? "";
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(digits)) digits = digits.replace(/,/gu, "");
  else if (/^\d{1,3}(?: \d{3})+(?:,\d+)?$/u.test(digits)) digits = digits.replace(/ /gu, "").replace(",", ".");
  else digits = digits.replace(",", ".");
  // Leading zeros carry no value: 05 and 5 are the same number, 0.5 keeps its zero.
  digits = digits.replace(/^0+(?=\d)/u, "");
  const negative = Boolean(groups.sign) || (Boolean(groups.open) && Boolean(groups.close));
  return `${negative && !/^0(?:\.0+)?$/u.test(digits) ? "-" : ""}${digits}${groups.percent === undefined ? "" : "%"}`;
}

/** Every number in the text, in order, in canonical form; times such as 7:04 are kept as written. */
export function numbersIn(text: string): string[] {
  const found: Array<{ at: number; value: string }> = [];
  // Times first, blanked out so their digits aren't read again as numbers.
  const plain = scoringText(text).replace(time, (value: string, at: number) => {
    found.push({ at, value });
    return " ".repeat(value.length);
  });
  for (const match of plain.matchAll(numberPattern)) found.push({ at: match.index, value: canonical(match) });
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.value);
}

/** How many times each number occurs. */
export function countNumbers(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** Occurrences in `a` beyond those in `b`, number by number. */
export function subtractCounts(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): Map<string, number> {
  const left = new Map<string, number>();
  for (const [value, count] of a) {
    const extra = count - (b.get(value) ?? 0);
    if (extra > 0) left.set(value, extra);
  }
  return left;
}

export const total = (counts: ReadonlyMap<string, number>) => [...counts.values()].reduce((sum, count) => sum + count, 0);

/**
 * Digit groups no real number has, the design's check F: a thousands group of four or more
 * digits ("$25,0002", a footnote mark fused into $25,000) or a digit right after a percent
 * sign ("10%4"). Each is returned as it appears in the text.
 */
export function impossibleNumbers(text: string): string[] {
  const plain = scoringText(text);
  const found: string[] = [];
  for (const match of plain.matchAll(/(?<![\p{N},.])\$?\d{1,3}(?:,\d{3})*,\d{4,}(?:\.\d+)?/gu)) found.push(match[0]);
  for (const match of plain.matchAll(/(?<![\p{N}.,])\d+(?:[.,]\d+)?%\d+/gu)) found.push(match[0]);
  return found;
}
