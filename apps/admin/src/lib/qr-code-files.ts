import { QR_NAME_LETTER_SPACING_EM, QR_PLATE_COLOR, qrCodeSvg, type QrBox, type QrCodeDrawing } from "./qr-code";

// The code alone as a file, for a designer or a print shop: a PNG drawn on a
// canvas in the page's own font, or an SVG with the logo inside it, so the
// file opens anywhere.

export type QrCodeFileOptions = {
  /** The name on the plate. */
  name: string;
  /** The logo's address, for a code with the logo in the middle. */
  logoSrc: string | null;
  /** A CSS font family; the PNG waits for it to load. */
  fontFamily: string;
  /** What the SVG calls the code. */
  title: string;
};

/** Pixels per module in the PNG: a version 6 code comes out 1,568 pixels square, sharp even at A4. */
export const QR_PNG_PIXELS_PER_MODULE = 32;

/** The file name for a business's code, such as joes-cafe-qr-code.png. */
export function qrCodeFileName(slug: string, extension: "png" | "svg"): string {
  return `${slug}-qr-code.${extension}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // A logo on another site taints the canvas unless that site allows it.
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`The logo at ${src} could not be loaded.`));
    image.src = src;
  });
}

/** The image's box inside the logo's square, keeping its shape. */
function contain(box: QrBox, width: number, height: number): QrBox {
  if (!width || !height) return box;
  const scale = Math.min(box.width / width, box.height / height);
  const fitted = { width: width * scale, height: height * scale };
  return { x: box.x + (box.width - fitted.width) / 2, y: box.y + (box.height - fitted.height) / 2, ...fitted };
}

/** The code as a PNG. It rejects when the canvas can't be read back, such as for a logo another site won't share. */
export async function qrCodePng(drawing: QrCodeDrawing, options: QrCodeFileOptions, pixelsPerModule = QR_PNG_PIXELS_PER_MODULE): Promise<Blob> {
  const { plate, logo } = drawing;
  const font = plate ? `700 ${plate.name.fontSize * pixelsPerModule}px ${options.fontFamily}` : null;
  const [image] = await Promise.all([
    logo && options.logoSrc ? loadImage(options.logoSrc) : Promise.resolve(null),
    font && document.fonts ? document.fonts.load(font, options.name) : Promise.resolve([]),
  ]);

  const canvas = document.createElement("canvas");
  canvas.width = drawing.size * pixelsPerModule;
  canvas.height = drawing.size * pixelsPerModule;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser can't draw the PNG.");

  context.scale(pixelsPerModule, pixelsPerModule);
  context.fillStyle = "#FFFFFF";
  context.fillRect(0, 0, drawing.size, drawing.size);
  context.fillStyle = "#000000";
  context.fill(new Path2D(drawing.modules));
  for (const { x, y } of drawing.finders) {
    context.fillStyle = "#000000";
    context.fillRect(x, y, 7, 7);
    context.fillStyle = "#FFFFFF";
    context.fillRect(x + 1, y + 1, 5, 5);
    context.fillStyle = "#000000";
    context.fillRect(x + 2, y + 2, 3, 3);
  }
  if (plate) {
    context.fillStyle = QR_PLATE_COLOR;
    context.beginPath();
    context.roundRect(plate.x, plate.y, plate.width, plate.height, plate.radius);
    context.fill();
    context.fillStyle = "#000000";
    context.fill(new Path2D(plate.brackets));
  }
  if (logo && image) {
    const box = contain(logo, image.naturalWidth, image.naturalHeight);
    context.drawImage(image, box.x, box.y, box.width, box.height);
  }
  // Text in pixels: some browsers round tiny font sizes, and a module is a fraction of one.
  context.setTransform(1, 0, 0, 1, 0, 0);
  if (plate && font) {
    const { name } = plate;
    context.font = font;
    context.letterSpacing = `${QR_NAME_LETTER_SPACING_EM * name.fontSize * pixelsPerModule}px`;
    context.textAlign = "center";
    context.textBaseline = "alphabetic";
    context.fillStyle = "#000000";
    context.fillText(options.name, name.x * pixelsPerModule, name.y * pixelsPerModule, (name.squeezeTo ?? name.maxWidth) * pixelsPerModule);
  }

  return await new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The PNG could not be made."))), "image/png");
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function dataUrl(src: string): Promise<string | null> {
  try {
    const response = await fetch(src);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("The logo could not be read."));
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** The code as an SVG file, with the logo inside it, or linked when its site won't share it. */
export async function qrCodeSvgFile(drawing: QrCodeDrawing, options: QrCodeFileOptions): Promise<Blob> {
  const logoHref = drawing.logo && options.logoSrc ? ((await dataUrl(options.logoSrc)) ?? new URL(options.logoSrc, window.location.href).toString()) : null;
  const svg = qrCodeSvg(drawing, { name: options.name, logoHref, title: options.title, fontFamily: options.fontFamily });
  return new Blob([svg], { type: "image/svg+xml" });
}

/** Saves a file through the browser's downloads. */
export function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Firefox still reads the address just after the click.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
