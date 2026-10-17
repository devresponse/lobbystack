import { describe, expect, it } from "vitest";

import { estimatedTextMeasure, layoutHeadline, messageParagraphs } from "./qr-code-headline";

// Every character half an em wide, so a line of 20 characters at size 10 is 100 wide.
const measure = estimatedTextMeasure(0.5);
// Two lines tall at the largest size.
const box = { width: 100, height: 20, lineHeight: 1, maxFontSize: 10, minFontSize: 5 };

describe("messageParagraphs", () => {
  it("keeps the typed lines, tidies spaces and drops empty lines", () => {
    expect(messageParagraphs("  Questions?  \r\n\n  Ask  us any   time. ")).toEqual(["Questions?", "Ask us any time."]);
    expect(messageParagraphs(" \n ")).toEqual([]);
  });
});

describe("layoutHeadline", () => {
  it("keeps the largest size when the message fits", () => {
    expect(layoutHeadline("Questions?\nAsk us any time.", box, measure)).toEqual({ fontSize: 10, lines: ["Questions?", "Ask us any time."] });
  });

  it("breaks lines between words", () => {
    expect(layoutHeadline("Skip the line and book your visit", box, measure)).toEqual({ fontSize: 10, lines: ["Skip the line and", "book your visit"] });
  });

  it("shrinks the text until it fits the box", () => {
    const layout = layoutHeadline("Skip the line. Book your next visit with us today.", box, measure);
    expect(layout.lines.length * layout.fontSize).toBeLessThanOrEqual(20);
    expect(layout.fontSize).toBeLessThan(10);
    expect(layout.fontSize).toBeGreaterThanOrEqual(5);
    for (const line of layout.lines) expect(measure(line, layout.fontSize)).toBeLessThanOrEqual(100);
    expect(layout.lines.join(" ")).toBe("Skip the line. Book your next visit with us today.");
  });

  it("breaks a word too long for a line", () => {
    const layout = layoutHeadline("Supercalifragilisticexpialidocious", { ...box, maxFontSize: 10, minFontSize: 10 }, measure);
    expect(layout.lines).toEqual(["Supercalifragilistic", "expialidocious"]);
  });

  it("takes more lines in the same box as the text gets smaller", () => {
    const layout = layoutHeadline("one two three four five six seven eight nine ten eleven twelve", box, measure);
    expect(layout.lines.length).toBeGreaterThan(2);
    expect(layout.lines.length * layout.fontSize).toBeLessThanOrEqual(20);
    expect(layout.lines.join(" ")).toBe("one two three four five six seven eight nine ten eleven twelve");
  });

  it("ends with an ellipsis when even the smallest size can't fit the message", () => {
    const layout = layoutHeadline("a ".repeat(200), { ...box, minFontSize: 8 }, measure);
    expect(layout.fontSize).toBe(8);
    expect(layout.lines).toHaveLength(2);
    expect(layout.lines[1]?.endsWith("…")).toBe(true);
    for (const line of layout.lines) expect(measure(line, 8)).toBeLessThanOrEqual(100);
  });

  it("leaves the headline out when the message is empty", () => {
    expect(layoutHeadline("   ", box, measure)).toEqual({ fontSize: 10, lines: [] });
  });

  it("counts an accented letter or an emoji as one character", () => {
    expect(measure("Café 👋🏽", 10)).toBe(30);
  });
});
