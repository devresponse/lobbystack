// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { drawQrCode } from "./qr-code";
import { QR_PNG_PIXELS_PER_MODULE, qrCodeFileName, qrCodePng, qrCodeSvgFile, saveFile } from "./qr-code-files";

const PROFILE_URL = "https://demo.alloplace.com/profile/alloplace";
const options = { name: "AlloPlace", logoSrc: "/brand/alloplace/logo.svg", fontFamily: '"Geist Variable", sans-serif', title: "QR code for AlloPlace" };

function fakeCanvas() {
  const context = {
    font: "",
    letterSpacing: "",
    textAlign: "",
    textBaseline: "",
    fillStyle: "",
    scale: vi.fn(),
    setTransform: vi.fn(),
    fillRect: vi.fn(),
    fill: vi.fn(),
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    drawImage: vi.fn(),
    fillText: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["png"], { type: "image/png" })));
  vi.stubGlobal(
    "Path2D",
    class {
      constructor(readonly path: string) {}
    },
  );
  return context;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("qrCodeFileName", () => {
  it("names the file after the business", () => {
    expect(qrCodeFileName("joes-cafe", "png")).toBe("joes-cafe-qr-code.png");
    expect(qrCodeFileName("joes-cafe", "svg")).toBe("joes-cafe-qr-code.svg");
  });
});

describe("qrCodePng", () => {
  it("draws the modules, the plate and the name in pixels", async () => {
    const context = fakeCanvas();
    const drawing = drawQrCode(PROFILE_URL, { mark: "name", nameWidthEm: 4.04 })!;

    const blob = await qrCodePng(drawing, options);

    expect(blob.type).toBe("image/png");
    expect(context.scale).toHaveBeenCalledWith(QR_PNG_PIXELS_PER_MODULE, QR_PNG_PIXELS_PER_MODULE);
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, drawing.size, drawing.size);
    expect(context.roundRect).toHaveBeenCalledWith(13.6, 21.6, 21.8, 5.8, 1);
    expect(context.font).toBe(`700 ${3.352 * QR_PNG_PIXELS_PER_MODULE}px "Geist Variable", sans-serif`);
    expect(context.fillText).toHaveBeenCalledWith("AlloPlace", 24.5 * 32, 25.69 * 32, 14.72 * 32);
    expect(context.drawImage).not.toHaveBeenCalled();
  });

  it("fits the logo in the middle, keeping its shape", async () => {
    const context = fakeCanvas();
    vi.stubGlobal(
      "Image",
      class {
        crossOrigin = "";
        naturalWidth = 200;
        naturalHeight = 100;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const drawing = drawQrCode(PROFILE_URL, { mark: "logo" })!;

    await qrCodePng(drawing, options);

    expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), expect.closeTo(18.9), expect.closeTo(20.7), expect.closeTo(7.2), expect.closeTo(3.6));
    expect(context.fillText).not.toHaveBeenCalled();
  });
});

describe("qrCodeSvgFile", () => {
  it("puts the logo inside the file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: async () => new Blob(["<svg/>"], { type: "image/svg+xml" }) })),
    );

    const blob = await qrCodeSvgFile(drawQrCode(PROFILE_URL, { mark: "logo" })!, options);

    expect(blob.type).toBe("image/svg+xml");
    expect(await blob.text()).toContain('<image href="data:image/svg+xml;base64,PHN2Zy8+"');
  });

  it("links the logo when it can't be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));

    const blob = await qrCodeSvgFile(drawQrCode(PROFILE_URL, { mark: "logo" })!, options);

    expect(await blob.text()).toContain(`<image href="${new URL("/brand/alloplace/logo.svg", window.location.href).toString()}"`);
  });

  it("leaves the logo out of a code with the name", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const text = await (await qrCodeSvgFile(drawQrCode(PROFILE_URL, { mark: "name", name: "AlloPlace" })!, options)).text();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(text).toContain(">AlloPlace</text>");
  });
});

describe("saveFile", () => {
  it("downloads the file under its name, then lets the address go", () => {
    vi.useFakeTimers();
    const original = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = vi.fn(() => "blob:qr");
    URL.revokeObjectURL = revokeObjectURL;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("joes-cafe-qr-code.png");
      expect(this.href).toBe("blob:qr");
    });
    try {
      saveFile(new Blob(["png"]), "joes-cafe-qr-code.png");

      expect(click).toHaveBeenCalledTimes(1);
      expect(document.querySelector("a")).toBeNull();
      expect(revokeObjectURL).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:qr");
    } finally {
      URL.createObjectURL = original.createObjectURL;
      URL.revokeObjectURL = original.revokeObjectURL;
      vi.useRealTimers();
    }
  });
});
