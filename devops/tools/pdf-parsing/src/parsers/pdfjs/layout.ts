/**
 * Turns one page's positioned text into lines, the way the design's repaired reader does:
 * cells split by wide gaps and written with " | ", small raised marks written as [^n],
 * and a row's values kept on its label's line when the label wraps. No AI and no guessing
 * of table structure: everything comes from where pdf.js (or OCR) says each piece of text is.
 */

/** A piece of text in PDF units: x from the left, y the baseline from the bottom, height the font size. */
export type TextItem = { str: string; x: number; y: number; width: number; height: number };

export type LayoutSettings = {
  /** A gap wider than this, in PDF units, starts a new cell. pdf-parse puts its tab at the same 7. */
  cellGap: number;
  /**
   * How many of the latest lines a piece of text may join. A value drawn after its label's second
   * line still lands on the label's first line, while a second column, drawn once the first column
   * is done, never joins it.
   */
  lookback: number;
};

export const defaultLayout: LayoutSettings = { cellGap: 7, lookback: 3 };

export const CELL_SEPARATOR = " | ";

export type PageLayout = { text: string; lines: number; cellLines: number; footnotes: number };

type Line = { items: TextItem[]; bottom: number; top: number; height: number };

// Footnote marks: one or two digits, or the usual symbols.
const footnoteMark = /^(?:\d{1,2}|[*†‡§¶])$/u;

const heightOf = (item: TextItem) => Math.max(item.height, 0.5);

/** How much of the smaller of the two boxes the other covers vertically, from 0 to 1. */
function verticalOverlap(item: TextItem, line: Line): number {
  const low = Math.max(item.y, line.bottom);
  const high = Math.min(item.y + heightOf(item), line.top);
  return (high - low) / Math.min(heightOf(item), line.top - line.bottom);
}

function groupLines(items: readonly TextItem[], settings: LayoutSettings): Line[] {
  const lines: Line[] = [];
  for (const item of items) {
    let best: Line | undefined;
    let bestOverlap = 0.5;
    for (const line of lines.slice(-settings.lookback)) {
      const overlap = verticalOverlap(item, line);
      if (overlap >= bestOverlap) {
        best = line;
        bestOverlap = overlap;
      }
    }
    if (best) {
      best.items.push(item);
      best.bottom = Math.min(best.bottom, item.y);
      best.top = Math.max(best.top, item.y + heightOf(item));
      best.height = Math.max(best.height, heightOf(item));
    } else {
      lines.push({ items: [item], bottom: item.y, top: item.y + heightOf(item), height: heightOf(item) });
    }
  }
  return lines;
}

/** A short mark set smaller than the text beside it and raised above its baseline. */
function isFootnoteMark(item: TextItem, beside: TextItem | undefined): boolean {
  if (!beside || !footnoteMark.test(item.str.trim())) return false;
  return heightOf(item) <= heightOf(beside) * 0.9 && item.y - beside.y >= heightOf(beside) * 0.25;
}

function renderLine(line: Line, settings: LayoutSettings): { text: string; cells: number; footnotes: number } {
  const items = [...line.items].sort((a, b) => a.x - b.x);
  const cells: string[] = [];
  let cell = "";
  let footnotes = 0;
  let previous: TextItem | undefined;
  let previousWasMark = false;
  items.forEach((item, index) => {
    const beside = previous && !previousWasMark ? previous : items[index + 1];
    if (isFootnoteMark(item, beside)) {
      footnotes += 1;
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
      if (gap > settings.cellGap) {
        cells.push(cell.trim());
        cell = "";
      } else if ((gap > Math.min(heightOf(item), heightOf(previous)) * 0.15 || previousWasMark) && !cell.endsWith(" ") && !text.startsWith(" ")) {
        cell += " ";
      }
    }
    cell += text;
    previous = item;
    previousWasMark = false;
  });
  cells.push(cell.trim());
  const kept = cells.filter((value) => value !== "");
  return { text: kept.join(CELL_SEPARATOR), cells: kept.length, footnotes };
}

/**
 * Lays out one page. Items come in the order the PDF draws them, which keeps a two-column
 * page's columns apart; within a line they are put in left-to-right order.
 */
export function layoutPage(items: readonly TextItem[], settings: LayoutSettings = defaultLayout): PageLayout {
  return layoutLines(groupLines(items.filter((item) => item.str.trim() !== ""), settings), settings);
}

/** Lays out lines that are already grouped, such as the lines Tesseract finds on a scanned page. */
export function layoutWordLines(wordLines: ReadonlyArray<readonly TextItem[]>, settings: LayoutSettings = defaultLayout): PageLayout {
  const lines = wordLines
    .map((words) => words.filter((word) => word.str.trim() !== ""))
    .filter((words) => words.length > 0)
    .map((words): Line => ({
      items: [...words],
      bottom: Math.min(...words.map((word) => word.y)),
      top: Math.max(...words.map((word) => word.y + heightOf(word))),
      height: Math.max(...words.map(heightOf)),
    }));
  return layoutLines(lines, settings);
}

function layoutLines(lines: readonly Line[], settings: LayoutSettings): PageLayout {
  const out: string[] = [];
  let cellLines = 0;
  let footnotes = 0;
  let previous: Line | undefined;
  for (const line of lines) {
    const rendered = renderLine(line, settings);
    if (!rendered.text) continue;
    // A blank line where the text jumps up (a new column) or leaves more than a line's gap (a new paragraph).
    if (previous && (line.top > previous.bottom + line.height || previous.bottom - line.top > line.height * 0.8)) out.push("");
    out.push(rendered.text);
    if (rendered.cells > 1) cellLines += 1;
    footnotes += rendered.footnotes;
    previous = line;
  }
  return { text: out.join("\n"), lines: out.filter((line) => line !== "").length, cellLines, footnotes };
}
