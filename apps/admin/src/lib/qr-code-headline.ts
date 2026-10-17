// Lays out the message a QR code sign prints as its headline: the largest
// font size within the size's limits at which the message fits the
// headline's box, as many lines as the box is tall. Lines break between
// words, wherever the message has a line break, and inside a word only when
// the word alone is too wide. The sign prints each line as laid out here, so
// the browser can't wrap it differently on paper.

/** A text's width at a font size, in the font size's unit. */
export type MeasureText = (text: string, fontSize: number) => number;

export type HeadlineBox = {
  width: number;
  height: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  maxFontSize: number;
  minFontSize: number;
};

export type HeadlineLayout = { fontSize: number; lines: string[] };

/** The longest message the screen takes, so it fits even the smallest card. */
export const QR_MESSAGE_MAX_LENGTH = 80;

// Each try is 4% smaller than the one before.
const FONT_SIZE_STEP = 0.96;
const ELLIPSIS = "…";

function graphemes(text: string): string[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment);
}

/** The message's lines as typed, with spaces tidied and empty lines dropped. */
export function messageParagraphs(message: string): string[] {
  return message
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Splits a word too wide for a line into pieces that fit, at least one character each. */
function breakWord(word: string, width: number, fontSize: number, measure: MeasureText): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const character of graphemes(word)) {
    if (piece && measure(piece + character, fontSize) > width) {
      pieces.push(piece);
      piece = character;
    } else {
      piece += character;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

function wrap(paragraphs: string[], width: number, fontSize: number, measure: MeasureText): string[] {
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate, fontSize) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      const pieces = measure(word, fontSize) <= width ? [word] : breakWord(word, width, fontSize, measure);
      lines.push(...pieces.slice(0, -1));
      line = pieces.at(-1) ?? "";
    }
    if (line) lines.push(line);
  }
  return lines;
}

function withEllipsis(line: string, width: number, fontSize: number, measure: MeasureText): string {
  const characters = graphemes(line);
  while (characters.length && measure(`${characters.join("").trimEnd()}${ELLIPSIS}`, fontSize) > width) characters.pop();
  return `${characters.join("").trimEnd()}${ELLIPSIS}`;
}

function fontSizes(box: HeadlineBox): number[] {
  const sizes: number[] = [];
  for (let size = box.maxFontSize; size > box.minFontSize; size *= FONT_SIZE_STEP) sizes.push(size);
  sizes.push(box.minFontSize);
  return sizes;
}

function roundSize(size: number): number {
  return Math.round(size * 100) / 100;
}

/** How many lines the box holds at a font size; at least one. */
function linesThatFit(box: HeadlineBox, fontSize: number): number {
  return Math.max(1, Math.floor(box.height / (fontSize * box.lineHeight) + 1e-6));
}

/**
 * The headline's font size and lines. A message that doesn't fit even at the
 * smallest size keeps the lines that do and ends the last with an ellipsis.
 */
export function layoutHeadline(message: string, box: HeadlineBox, measure: MeasureText): HeadlineLayout {
  const paragraphs = messageParagraphs(message);
  if (!paragraphs.length) return { fontSize: roundSize(box.maxFontSize), lines: [] };
  for (const fontSize of fontSizes(box)) {
    const lines = wrap(paragraphs, box.width, fontSize, measure);
    if (lines.length <= linesThatFit(box, fontSize)) return { fontSize: roundSize(fontSize), lines };
  }
  const fontSize = box.minFontSize;
  const lines = wrap(paragraphs, box.width, fontSize, measure).slice(0, linesThatFit(box, fontSize));
  const last = lines.length - 1;
  lines[last] = withEllipsis(lines[last] ?? "", box.width, fontSize, measure);
  return { fontSize: roundSize(fontSize), lines };
}

/** Widths as an even guess per character, for when the page can't measure text. */
export function estimatedTextMeasure(characterWidthEm = 0.55): MeasureText {
  return (text, fontSize) => graphemes(text).length * characterWidthEm * fontSize;
}

/**
 * Widths measured in the page's own font, with the sign's letter spacing.
 * Null when the page has no canvas to measure with. Measure only once the
 * font has loaded, or the widths are the fallback font's.
 */
export function canvasTextMeasure(font: { family: string; weight: number; letterSpacingEm: number }): MeasureText | null {
  if (typeof document === "undefined") return null;
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = document.createElement("canvas").getContext("2d");
  } catch {
    context = null;
  }
  if (!context) return null;
  context.font = `${font.weight} 100px ${font.family}`;
  const canvas = context;
  const widths = new Map<string, number>();
  return (text, fontSize) => {
    let width = widths.get(text);
    if (width === undefined) {
      width = canvas.measureText(text).width / 100 + font.letterSpacingEm * graphemes(text).length;
      widths.set(text, width);
    }
    return width * fontSize;
  };
}
