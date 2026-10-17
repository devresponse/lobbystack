import QRCode from "qrcode";

// A QR code drawn the way AlloPlace's own QR template draws one
// (devresponse/alloplace.ai, docs/brand/qr and generator/qrbrand.py): square
// modules, solid finder patterns and, in the middle, either a yellow plate
// with brackets and the deployment's name or its logo on a white square.
// Something in the middle needs error correction H, and it must never touch
// the finder, timing or alignment patterns. From version 7 an alignment
// pattern sits at the very centre, so only codes up to version 6 (addresses
// up to 58 bytes) take a name or a logo; longer ones get a plain code.
// Coordinates are in modules, with the quiet zone included.

/** What sits in the middle of the code. */
export type QrCodeMark = "name" | "logo" | "none";

export type QrErrorCorrection = "Q" | "H";

/** The light margin around the code, in modules, that the QR standard asks for. */
export const QR_QUIET_ZONE = 4;

/** The longest address, in bytes, that still takes a name or a logo: version 6 at error correction H. */
export const QR_MARK_MAX_BYTES = 58;

/** The plate's colour: Cadre's signal yellow. */
export const QR_PLATE_COLOR = "#FFD100";

const MARK_MAX_VERSION = 6;
// AlloPlace's template: a 7 × 23 module plate on a version 6 code (41 × 41), 9.6% of it covered.
const NAME_VERSION = 6;
const PLATE_ROWS = 7;
const PLATE_COLUMNS = 23;
// A 9 × 9 module square for the logo, on a version 5 or 6 code.
const LOGO_MIN_VERSION = 5;
const LOGO_CELLS = 9;
const LOGO_INSET = 0.9;
// The plate's look, from the template: inset from the cleared modules, corner, brackets.
const PLATE_INSET = 0.6;
const PLATE_RADIUS = 1;
const BRACKET_OFFSET = 1.3;
const BRACKET_ARM = 2.2;
const BRACKET_THICKNESS = 0.6;
// The name: Geist Bold, cap height 0.71 em, tracked in by 0.03 em.
const NAME_CAP_HEIGHT_EM = 0.71;
const NAME_HEIGHT_SHARE = 0.34;
const NAME_WIDTH_SHARE = 0.64;
const NAME_MIN_FONT_SIZE = 1.6;
/** How far the name's letters are tracked in, in em. */
export const QR_NAME_LETTER_SPACING_EM = -0.03;
// A rough width per character in Geist Bold, for when the page can't measure the name.
const ESTIMATED_CHARACTER_WIDTH_EM = 0.56;

export type QrBox = { x: number; y: number; width: number; height: number };

export type QrPlate = QrBox & {
  radius: number;
  /** The top-left and bottom-right brackets, as one SVG path. */
  brackets: string;
  name: {
    /** The centre of the name's baseline. */
    x: number;
    y: number;
    fontSize: number;
    /** The widest the name may be. */
    maxWidth: number;
    /** Set when the name is too long for the plate at the smallest size: squeeze it to this width. */
    squeezeTo: number | null;
  };
};

export type QrCodeDrawing = {
  /** The text the code holds. */
  text: string;
  version: number;
  errorCorrection: QrErrorCorrection;
  /** What the middle shows: the mark asked for, or "none" when the text is too long for one. */
  mark: QrCodeMark;
  /** Width and height in modules, quiet zone included. */
  size: number;
  /** The dark modules outside the finder patterns and the middle, as one SVG path. */
  modules: string;
  /** The top-left corners of the three 7 × 7 finder patterns. */
  finders: Array<{ x: number; y: number }>;
  /** The modules left out in the middle, or null for a plain code. */
  cleared: QrBox | null;
  plate: QrPlate | null;
  /** Where the logo goes, inside the cleared square. */
  logo: QrBox | null;
  /** The encoded modules before the middle covers any: row by row, 1 where a module is dark. */
  matrix: { size: number; data: Uint8Array };
};

export type QrCodeOptions = {
  mark: QrCodeMark;
  /**
   * The name's width in em in Geist Bold, letter spacing included, as the page
   * measured it. Without it, the width is estimated from the name's length.
   */
  nameWidthEm?: number | undefined;
  /** The name the plate shows, used to estimate its width. */
  name?: string | undefined;
};

function encode(text: string, errorCorrection: QrErrorCorrection, version?: number): QRCode.QRCode | null {
  try {
    return QRCode.create(text, version ? { errorCorrectionLevel: errorCorrection, version } : { errorCorrectionLevel: errorCorrection });
  } catch {
    // Too much text for this version, or for any.
    return null;
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function finderCorners(n: number): Array<{ row: number; column: number }> {
  return [
    { row: 0, column: 0 },
    { row: 0, column: n - 7 },
    { row: n - 7, column: 0 },
  ];
}

function inBox(box: { row: number; column: number; rows: number; columns: number }, row: number, column: number): boolean {
  return row >= box.row && row < box.row + box.rows && column >= box.column && column < box.column + box.columns;
}

function modulesPath(n: number, data: Uint8Array, skip: (row: number, column: number) => boolean): string {
  const parts: string[] = [];
  for (let row = 0; row < n; row++) {
    let column = 0;
    while (column < n) {
      if (data[row * n + column] && !skip(row, column)) {
        const start = column;
        while (column < n && data[row * n + column] && !skip(row, column)) column++;
        const width = column - start;
        parts.push(`M${start + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h${width}v1h${-width}z`);
      } else {
        column++;
      }
    }
  }
  return parts.join("");
}

/** A name's rough width in em, for when the page can't measure it. */
export function estimateNameWidthEm(name: string): number {
  const characters = Array.from(name).length;
  return characters * ESTIMATED_CHARACTER_WIDTH_EM + Math.max(0, characters - 1) * QR_NAME_LETTER_SPACING_EM;
}

function plateFor(cleared: QrBox, nameWidthEm: number): QrPlate {
  const x = cleared.x + PLATE_INSET;
  const y = cleared.y + PLATE_INSET;
  const width = cleared.width - 2 * PLATE_INSET;
  const height = cleared.height - 2 * PLATE_INSET;
  const left = cleared.x + BRACKET_OFFSET;
  const top = cleared.y + BRACKET_OFFSET;
  const right = cleared.x + cleared.width - BRACKET_OFFSET;
  const bottom = cleared.y + cleared.height - BRACKET_OFFSET;
  const arm = BRACKET_ARM;
  const thickness = BRACKET_THICKNESS;
  const brackets =
    `M${round(left)} ${round(top)}h${arm}v${thickness}h${round(thickness - arm)}v${round(arm - thickness)}h${-thickness}z` +
    `M${round(right)} ${round(bottom)}h${-arm}v${-thickness}h${round(arm - thickness)}v${round(thickness - arm)}h${thickness}z`;
  const maxWidth = cleared.width * NAME_WIDTH_SHARE;
  let fontSize = (cleared.height * NAME_HEIGHT_SHARE) / NAME_CAP_HEIGHT_EM;
  if (nameWidthEm > 0 && nameWidthEm * fontSize > maxWidth) fontSize = maxWidth / nameWidthEm;
  let squeezeTo: number | null = null;
  if (fontSize < NAME_MIN_FONT_SIZE) {
    fontSize = NAME_MIN_FONT_SIZE;
    squeezeTo = round(maxWidth);
  }
  return {
    x: round(x),
    y: round(y),
    width: round(width),
    height: round(height),
    radius: PLATE_RADIUS,
    brackets,
    name: {
      x: round(cleared.x + cleared.width / 2),
      y: round(cleared.y + (cleared.height + fontSize * NAME_CAP_HEIGHT_EM) / 2),
      fontSize: round(fontSize),
      maxWidth: round(maxWidth),
      squeezeTo,
    },
  };
}

/**
 * The code for a text, with the mark asked for when the text is short enough
 * for one. Null when the text doesn't fit in any QR code.
 */
export function drawQrCode(text: string, options: QrCodeOptions): QrCodeDrawing | null {
  let mark = options.mark;
  let qr: QRCode.QRCode | null = null;
  if (mark !== "none") {
    const smallest = encode(text, "H");
    if (smallest && smallest.version <= MARK_MAX_VERSION) {
      const version = mark === "name" ? NAME_VERSION : Math.max(LOGO_MIN_VERSION, smallest.version);
      qr = encode(text, "H", version);
    }
    if (!qr) mark = "none";
  }
  if (!qr) qr = encode(text, "Q");
  if (!qr) return null;

  const n = qr.modules.size;
  const data = qr.modules.data;
  const centre = Math.floor(n / 2);
  const middle =
    mark === "name"
      ? { row: centre - (PLATE_ROWS - 1) / 2, column: centre - (PLATE_COLUMNS - 1) / 2, rows: PLATE_ROWS, columns: PLATE_COLUMNS }
      : mark === "logo"
        ? { row: centre - (LOGO_CELLS - 1) / 2, column: centre - (LOGO_CELLS - 1) / 2, rows: LOGO_CELLS, columns: LOGO_CELLS }
        : null;
  const finders = finderCorners(n);
  const skip = (row: number, column: number) =>
    finders.some((finder) => inBox({ ...finder, rows: 7, columns: 7 }, row, column)) || (middle !== null && inBox(middle, row, column));
  const cleared = middle ? { x: middle.column + QR_QUIET_ZONE, y: middle.row + QR_QUIET_ZONE, width: middle.columns, height: middle.rows } : null;

  return {
    text,
    version: qr.version,
    errorCorrection: mark === "none" ? "Q" : "H",
    mark,
    size: n + 2 * QR_QUIET_ZONE,
    modules: modulesPath(n, data, skip),
    finders: finders.map((finder) => ({ x: finder.column + QR_QUIET_ZONE, y: finder.row + QR_QUIET_ZONE })),
    cleared,
    plate: cleared && mark === "name" ? plateFor(cleared, options.nameWidthEm ?? estimateNameWidthEm(options.name ?? "")) : null,
    logo:
      cleared && mark === "logo"
        ? { x: cleared.x + LOGO_INSET, y: cleared.y + LOGO_INSET, width: round(cleared.width - 2 * LOGO_INSET), height: round(cleared.height - 2 * LOGO_INSET) }
        : null,
    matrix: { size: n, data: Uint8Array.from(data) },
  };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export type QrCodeSvgOptions = {
  /** The name on the plate. */
  name: string;
  /** The logo image, best as a data: URL so the file stands alone. */
  logoHref: string | null;
  /** What screen readers and file viewers call the code. */
  title: string;
  fontFamily: string;
  /** The rendered width and height, in pixels. */
  pixelSize?: number;
};

/** The code as a standalone SVG file. */
export function qrCodeSvg(drawing: QrCodeDrawing, options: QrCodeSvgOptions): string {
  const { size } = drawing;
  const pixels = options.pixelSize ?? size * 10;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${pixels}" height="${pixels}" shape-rendering="crispEdges">`,
    `<title>${escapeXml(options.title)}</title>`,
    `<rect width="${size}" height="${size}" fill="#FFFFFF"/>`,
    `<path d="${drawing.modules}" fill="#000000"/>`,
  ];
  for (const { x, y } of drawing.finders) {
    parts.push(
      `<rect x="${x}" y="${y}" width="7" height="7" fill="#000000"/>`,
      `<rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#FFFFFF"/>`,
      `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" fill="#000000"/>`,
    );
  }
  const { plate, logo } = drawing;
  if (plate) {
    const { name } = plate;
    const squeeze = name.squeezeTo ? ` textLength="${name.squeezeTo}" lengthAdjust="spacingAndGlyphs"` : "";
    parts.push(
      `<rect x="${plate.x}" y="${plate.y}" width="${plate.width}" height="${plate.height}" rx="${plate.radius}" fill="${QR_PLATE_COLOR}" shape-rendering="geometricPrecision"/>`,
      `<path d="${plate.brackets}" fill="#000000"/>`,
      `<text x="${name.x}" y="${name.y}" text-anchor="middle" font-family="${escapeXml(options.fontFamily)}" font-weight="700" font-size="${name.fontSize}" letter-spacing="${round(QR_NAME_LETTER_SPACING_EM * name.fontSize)}"${squeeze} fill="#000000" shape-rendering="geometricPrecision">${escapeXml(options.name)}</text>`,
    );
  }
  if (logo && options.logoHref) {
    parts.push(
      `<image href="${escapeXml(options.logoHref)}" x="${logo.x}" y="${logo.y}" width="${logo.width}" height="${logo.height}" preserveAspectRatio="xMidYMid meet"/>`,
    );
  }
  parts.push("</svg>");
  return parts.join("");
}
