import jsQR from "jsqr";
import { describe, expect, it } from "vitest";

import { drawQrCode, estimateNameWidthEm, QR_MARK_MAX_BYTES, QR_QUIET_ZONE, qrCodeSvg, type QrCodeDrawing } from "./qr-code";

const DEMO_URL = "https://demo.alloplace.com/profile/alloplace";
const PIXELS_PER_MODULE = 6;

/** Addresses from 20 to 58 bytes, the range that takes a name or a logo. */
const MARKED_URLS = [
  "https://a.co/profile/ab",
  "https://example.com/profile/joes",
  DEMO_URL,
  "https://reception.example.com/profile/cafe-du-coin",
  `https://demo.alloplace.com/profile/${"a".repeat(QR_MARK_MAX_BYTES - "https://demo.alloplace.com/profile/".length)}`,
];

/** The module grid the drawing paints: 1 where a module is dark. */
function paintedGrid(drawing: QrCodeDrawing): Uint8Array {
  const { size } = drawing;
  const grid = new Uint8Array(size * size);
  for (const run of drawing.modules.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, width] = [Number(run[1]), Number(run[2]), Number(run[3])];
    for (let column = x; column < x + width; column++) grid[y * size + column] = 1;
  }
  for (const { x, y } of drawing.finders) {
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 7; column++) {
        const ring = row === 0 || row === 6 || column === 0 || column === 6;
        const centre = row >= 2 && row <= 4 && column >= 2 && column <= 4;
        grid[(y + row) * size + x + column] = ring || centre ? 1 : 0;
      }
    }
  }
  return grid;
}

function inCleared(drawing: QrCodeDrawing, x: number, y: number): boolean {
  const box = drawing.cleared;
  return box !== null && x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
}

/**
 * Decodes the drawing as a phone would, with every module in the middle read
 * the wrong way round: harsher than any plate, bracket or logo can be.
 */
function decodeWorstCase(drawing: QrCodeDrawing): string | null {
  const { size, matrix } = drawing;
  const grid = paintedGrid(drawing);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inCleared(drawing, x, y)) continue;
      const truth = matrix.data[(y - QR_QUIET_ZONE) * matrix.size + x - QR_QUIET_ZONE];
      grid[y * size + x] = truth ? 0 : 1;
    }
  }
  const width = size * PIXELS_PER_MODULE;
  const pixels = new Uint8ClampedArray(width * width * 4);
  for (let py = 0; py < width; py++) {
    for (let px = 0; px < width; px++) {
      const dark = grid[Math.floor(py / PIXELS_PER_MODULE) * size + Math.floor(px / PIXELS_PER_MODULE)];
      const offset = (py * width + px) * 4;
      pixels.fill(dark ? 0 : 255, offset, offset + 3);
      pixels[offset + 3] = 255;
    }
  }
  return jsQR(pixels, width, width, { inversionAttempts: "dontInvert" })?.data ?? null;
}

function expectPaintedLikeTheMatrix(drawing: QrCodeDrawing) {
  const { size, matrix } = drawing;
  const grid = paintedGrid(drawing);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = x >= QR_QUIET_ZONE && y >= QR_QUIET_ZONE && x < size - QR_QUIET_ZONE && y < size - QR_QUIET_ZONE;
      const expected = inside && !inCleared(drawing, x, y) ? (matrix.data[(y - QR_QUIET_ZONE) * matrix.size + x - QR_QUIET_ZONE] ?? 0) : 0;
      expect(grid[y * size + x], `module ${x}, ${y}`).toBe(expected);
    }
  }
}

describe("drawQrCode", () => {
  it("draws the name plate the way AlloPlace's template does", () => {
    const drawing = drawQrCode(DEMO_URL, { mark: "name", name: "AlloPlace", nameWidthEm: 4.04 });

    expect(drawing).toMatchObject({ text: DEMO_URL, version: 6, errorCorrection: "H", mark: "name", size: 41 + 2 * QR_QUIET_ZONE });
    expect(drawing?.cleared).toEqual({ x: 13, y: 21, width: 23, height: 7 });
    expect(drawing?.plate).toMatchObject({ x: 13.6, y: 21.6, width: 21.8, height: 5.8, radius: 1 });
    expect(drawing?.plate?.name).toEqual({ x: 24.5, y: 25.69, fontSize: 3.352, maxWidth: 14.72, squeezeTo: null });
    expect(drawing?.logo).toBeNull();
    expectPaintedLikeTheMatrix(drawing!);
  });

  it("clears a 9 by 9 square for the logo on a version 5 or 6 code", () => {
    const short = drawQrCode("https://a.co/profile/ab", { mark: "logo" });
    expect(short).toMatchObject({ version: 5, errorCorrection: "H", mark: "logo", plate: null });
    expect(short?.cleared).toEqual({ x: 18, y: 18, width: 9, height: 9 });
    expect(short?.logo).toEqual({ x: 18.9, y: 18.9, width: 7.2, height: 7.2 });

    const longest = drawQrCode(MARKED_URLS.at(-1)!, { mark: "logo" });
    expect(longest).toMatchObject({ version: 6, mark: "logo" });
    expect(longest?.cleared).toEqual({ x: 20, y: 20, width: 9, height: 9 });
    expectPaintedLikeTheMatrix(longest!);
  });

  it.each(MARKED_URLS)("still scans with the middle read wrong: %s", (url) => {
    for (const mark of ["name", "logo"] as const) {
      const drawing = drawQrCode(url, { mark, name: "AlloPlace" });
      expect(drawing?.mark, mark).toBe(mark);
      expect(decodeWorstCase(drawing!), mark).toBe(url);
    }
  });

  it("gives a longer address a plain code", () => {
    const url = `https://demo.alloplace.com/profile/${"a".repeat(QR_MARK_MAX_BYTES + 1 - "https://demo.alloplace.com/profile/".length)}`;
    for (const mark of ["name", "logo", "none"] as const) {
      const drawing = drawQrCode(url, { mark, name: "AlloPlace" });
      expect(drawing).toMatchObject({ mark: "none", errorCorrection: "Q", cleared: null, plate: null, logo: null });
      expectPaintedLikeTheMatrix(drawing!);
      expect(decodeWorstCase(drawing!)).toBe(url);
    }
  });

  it("draws a plain code at the smallest version when asked for nothing", () => {
    const drawing = drawQrCode(DEMO_URL, { mark: "none" });
    expect(drawing).toMatchObject({ mark: "none", errorCorrection: "Q", version: 4, size: 33 + 2 * QR_QUIET_ZONE });
    expect(decodeWorstCase(drawing!)).toBe(DEMO_URL);
  });

  it("returns null for text no QR code can hold", () => {
    expect(drawQrCode("x".repeat(3000), { mark: "none" })).toBeNull();
  });

  it("shrinks a long name to fit the plate, then squeezes it", () => {
    const fitted = drawQrCode(DEMO_URL, { mark: "name", nameWidthEm: 7 })?.plate?.name;
    expect(fitted?.fontSize).toBeCloseTo((23 * 0.64) / 7, 3);
    expect(fitted?.squeezeTo).toBeNull();

    const squeezed = drawQrCode(DEMO_URL, { mark: "name", nameWidthEm: 20 })?.plate?.name;
    expect(squeezed).toMatchObject({ fontSize: 1.6, squeezeTo: 14.72 });
  });

  it("estimates a name's width from its length when the page can't measure it", () => {
    expect(estimateNameWidthEm("")).toBe(0);
    expect(estimateNameWidthEm("AlloPlace")).toBeCloseTo(9 * 0.56 - 8 * 0.03, 6);
    const estimated = drawQrCode(DEMO_URL, { mark: "name", name: "AlloPlace" })?.plate?.name;
    expect(estimated?.fontSize).toBeCloseTo((23 * 0.64) / estimateNameWidthEm("AlloPlace"), 3);
  });
});

describe("qrCodeSvg", () => {
  const options = { name: "Joe's <Café>", logoHref: null, title: "QR code for Joe's", fontFamily: "Geist, sans-serif" };

  it("writes the plate, the brackets and the escaped name", () => {
    const svg = qrCodeSvg(drawQrCode(DEMO_URL, { mark: "name", nameWidthEm: 4 })!, options);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 49 49" width="490" height="490"/);
    expect(svg).toContain("<title>QR code for Joe&apos;s</title>");
    expect(svg).toContain('fill="#FFD100"');
    expect(svg).toContain(">Joe&apos;s &lt;Café&gt;</text>");
    expect(svg).not.toContain("textLength");
    expect(svg).not.toContain("<image");
  });

  it("squeezes a name that is too long for the plate", () => {
    const svg = qrCodeSvg(drawQrCode(DEMO_URL, { mark: "name", nameWidthEm: 20 })!, options);
    expect(svg).toContain('textLength="14.72" lengthAdjust="spacingAndGlyphs"');
  });

  it("places the logo in the middle", () => {
    const svg = qrCodeSvg(drawQrCode(DEMO_URL, { mark: "logo" })!, { ...options, logoHref: "data:image/svg+xml;base64,PHN2Zy8+" });
    expect(svg).toContain('<image href="data:image/svg+xml;base64,PHN2Zy8+" x="18.9" y="18.9" width="7.2" height="7.2" preserveAspectRatio="xMidYMid meet"/>');
    expect(svg).not.toContain("<text");
  });

  it("draws nothing in the middle of a plain code", () => {
    const svg = qrCodeSvg(drawQrCode(DEMO_URL, { mark: "none" })!, { ...options, logoHref: "/logo.svg", pixelSize: 300 });
    expect(svg).toContain('width="300" height="300"');
    expect(svg).not.toContain("#FFD100");
    expect(svg).not.toContain("<image");
  });
});
