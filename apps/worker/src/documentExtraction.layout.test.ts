import { describe, expect, it } from "vitest";

import { layoutPdfPage, layoutPdfWordLines, type PdfTextItem } from "./documentExtraction";

// Items the way pdf.js gives them for a fictional budget: x and the baseline y in PDF units, height the font size.
const item = (str: string, x: number, y: number, width: number, height = 10): PdfTextItem => ({ str, x, y, width, height });

describe("PDF page layout", () => {
  it("splits cells at wide gaps and writes them with |", () => {
    expect(layoutPdfPage([item("Strata fees", 40.5, 657.8, 48.3), item(" ", 88.8, 657.8, 380.2, 0), item("$412,800", 374, 657.8, 41.7), item("7.0%", 557.7, 657.8, 22.8)])).toBe("Strata fees | $412,800 | 7.0%");
  });

  it("writes a small raised mark as a footnote instead of fusing it into the number", () => {
    const page = layoutPdfPage([
      item("Building deductible", 36, 730.5, 83.9),
      item("$25,000", 166, 729.4, 36.1),
      item("2", 202.2, 733.5, 4.6, 8.3),
      item("2", 27, 654, 4.6, 8.3),
      item("Per claim.", 34.4, 649.9, 44.4),
    ]);
    expect(page).toBe("Building deductible | $25,000 [^2]\n\n[^2]: Per claim.");
  });

  it("keeps a row's values on its label's first line when the label wraps", () => {
    // The PDF draws the label's two lines first, then goes back up for the values.
    const page = layoutPdfPage([
      item("Insurance premium (building, liability, and directors' and officers'", 40.5, 573, 282.4),
      item("coverage)", 40.5, 559.2, 44.5),
      item("1", 85, 563.3, 4.6, 8.3),
      item("96,000", 385.1, 573, 30.6),
      item("104,212", 430.3, 573, 36.1),
    ]);
    expect(page).toBe("Insurance premium (building, liability, and directors' and officers' | 96,000 | 104,212\ncoverage) [^1]");
  });

  it("keeps a second column apart from the first", () => {
    const left = Array.from({ length: 6 }, (_, line) => item(`left ${line}`, 27, 700 - line * 12, 40));
    const right = Array.from({ length: 6 }, (_, line) => item(`right ${line}`, 316, 700 - line * 12, 40));
    expect(layoutPdfPage([...left, ...right])).toBe([...left.map((entry) => entry.str), "", ...right.map((entry) => entry.str)].join("\n"));
  });

  it("lays out OCR lines with the same cell rule", () => {
    expect(layoutPdfWordLines([[item("Water", 40, 500, 25), item("and", 67, 500, 16), item("sewer", 85, 500, 26), item("31,000", 380, 500, 30)]])).toBe("Water and sewer | 31,000");
  });
});
