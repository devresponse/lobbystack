import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  destroy: vi.fn(),
  extractRawText: vi.fn(),
  getScreenshot: vi.fn(),
  getText: vi.fn(),
  loads: { mammoth: 0, pdf: 0, tesseract: 0 },
  recognize: vi.fn(),
  terminate: vi.fn(),
}));

vi.mock("mammoth", () => {
  mocks.loads.mammoth += 1;
  return { default: { extractRawText: mocks.extractRawText } };
});

vi.mock("pdf-parse", () => {
  mocks.loads.pdf += 1;
  return {
    PDFParse: class {
      destroy = mocks.destroy;
      getScreenshot = mocks.getScreenshot;
      getText = mocks.getText;
    },
  };
});

vi.mock("tesseract.js", () => {
  mocks.loads.tesseract += 1;
  return { createWorker: mocks.createWorker };
});

import { extractDocumentText } from "./documentExtraction";

const pdf = "application/pdf";
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));

// A PDF whose pages each hold one line of Helvetica, or nothing, with a cross-reference table so pdf.js reads it as written.
function pdfFile(pages: Array<string | null>): Uint8Array {
  const objects = ["", "<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  pages.forEach((text, index) => {
    const stream = text === null ? "" : `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let file = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, id) => {
    if (id === 0) return;
    offsets.push(file.length);
    file += `${id} 0 obj\n${object}\nendobj\n`;
  });
  const xref = file.length;
  file += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer << /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(file);
}

// What tesseract.js gives with blocks on: one line of words, in pixels of the page rendered at scale 2.
function ocrLine(words: string[]) {
  let x = 100;
  const boxes = words.map((text) => {
    const bbox = { x0: x, y0: 100, x1: x + text.length * 12, y1: 124 };
    x = bbox.x1 + 12;
    return { text, bbox };
  });
  return { data: { text: words.join(" "), blocks: [{ paragraphs: [{ lines: [{ words: boxes, baseline: { x0: 100, y0: 124, x1: x, y1: 124 } }] }] }] } };
}

describe("knowledge document extraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mocks.createWorker.mockResolvedValue({ recognize: mocks.recognize, terminate: mocks.terminate });
    mocks.terminate.mockResolvedValue(undefined);
    mocks.destroy.mockResolvedValue(undefined);
  });

  it("does not load extraction dependencies when the module or plain text path is used", async () => {
    expect(mocks.loads).toEqual({ mammoth: 0, pdf: 0, tesseract: 0 });

    await expect(extractDocumentText({ body: new TextEncoder().encode("plain"), contentType: "text/plain" })).resolves.toBe("plain");

    expect(mocks.loads).toEqual({ mammoth: 0, pdf: 0, tesseract: 0 });
  });

  it("extracts UTF-8 text documents", async () => {
    await expect(extractDocumentText({ body: new TextEncoder().encode("English et français"), contentType: "text/plain; charset=utf-8" })).resolves.toBe("English et français");
  });

  it("uses the PDF text layer without OCR when text is available", async () => {
    vi.stubEnv("KNOWLEDGE_PDF_READER", "original");
    mocks.getText.mockResolvedValue({ text: "Business hours", total: 1 });

    await expect(extractDocumentText({ body: new Uint8Array([1]), contentType: "application/pdf" })).resolves.toBe("Business hours");

    expect(mocks.getScreenshot).not.toHaveBeenCalled();
    expect(mocks.createWorker).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.loads.pdf).toBe(1);
    expect(mocks.loads.tesseract).toBe(0);
  });

  it("loads mammoth only for DOCX extraction", async () => {
    mocks.extractRawText.mockResolvedValue({ value: "Document text" });

    await expect(extractDocumentText({ body: new Uint8Array([1]), contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).resolves.toBe("Document text");

    expect(mocks.loads.mammoth).toBe(1);
  });

  it("OCRs every page of a textless PDF with one bilingual worker", async () => {
    vi.stubEnv("KNOWLEDGE_PDF_READER", "original");
    mocks.getText.mockResolvedValue({ text: "  ", total: 2 });
    mocks.getScreenshot.mockResolvedValue({
      pages: [{ data: new Uint8Array([1]) }, { data: new Uint8Array([2]) }],
      total: 2,
    });
    mocks.recognize
      .mockResolvedValueOnce({ data: { text: "Bonjour du scan\n" } })
      .mockResolvedValueOnce({ data: { text: "Hours by appointment" } });

    await expect(extractDocumentText({ body: new Uint8Array([1]), contentType: "application/pdf" })).resolves.toBe("Bonjour du scan\n\nHours by appointment");

    expect(mocks.getScreenshot).toHaveBeenCalledWith({ imageBuffer: true, imageDataUrl: false, scale: 2 });
    expect(mocks.createWorker).toHaveBeenCalledWith(["eng", "fra"]);
    expect(mocks.recognize).toHaveBeenNthCalledWith(1, Buffer.from([1]));
    expect(mocks.recognize).toHaveBeenNthCalledWith(2, Buffer.from([2]));
    expect(mocks.terminate).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.loads.tesseract).toBe(1);
  });

  it("rejects textless PDFs above the OCR page limit", async () => {
    vi.stubEnv("KNOWLEDGE_PDF_READER", "original");
    mocks.getText.mockResolvedValue({ text: "", total: 26 });

    await expect(extractDocumentText({ body: new Uint8Array([1]), contentType: "application/pdf" })).rejects.toThrow("Scanned PDF OCR is limited to 25 pages");

    expect(mocks.getScreenshot).not.toHaveBeenCalled();
    expect(mocks.createWorker).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("reads PDFs with the improved reader by default: cells, footnote marks and page markers", async () => {
    const text = await extractDocumentText({ body: fixture("notes.pdf"), contentType: pdf });

    expect(text).toMatch(/^\[Page 1 of 1\]$/mu);
    expect(text).toContain("Building deductible | $25,000 [^2]");
    expect(text).not.toContain("$25,0002");
    expect(mocks.getText).not.toHaveBeenCalled();
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it("keeps each table row's cells apart and marks every page", async () => {
    const text = await extractDocumentText({ body: fixture("fees.pdf"), contentType: pdf });

    expect(text).toMatch(/^\[Page 1 of 2\]$/mu);
    expect(text).toMatch(/^\[Page 2 of 2\]$/mu);
    expect(text).toContain("7 | 107 | 103 | $631.88 | $228.25 | $860.13");
  });

  it("OCRs only the pages without a text layer, with one bilingual worker", async () => {
    mocks.recognize.mockResolvedValueOnce(ocrLine(["Hours", "by", "appointment"]));
    const recordOcr = vi.fn();

    await expect(extractDocumentText({ body: pdfFile(["Open daily", null]), contentType: pdf }, recordOcr)).resolves.toBe("[Page 1 of 2]\nOpen daily\n\n[Page 2 of 2, read by OCR]\nHours by appointment");

    expect(mocks.createWorker).toHaveBeenCalledWith(["eng", "fra"]);
    expect(mocks.recognize).toHaveBeenCalledOnce();
    expect((mocks.recognize.mock.calls[0]?.[0] as Buffer).subarray(0, 4).toString("latin1")).toBe("\x89PNG");
    expect(mocks.terminate).toHaveBeenCalledOnce();
    expect(recordOcr).toHaveBeenCalledWith(expect.any(Number), { source_type: "pdf", page_count: 1 });
    expect(mocks.getText).not.toHaveBeenCalled();
  });

  it("refuses a scan longer than the OCR page limit without reading it again", async () => {
    await expect(extractDocumentText({ body: pdfFile(Array.from({ length: 26 }, () => null)), contentType: pdf })).rejects.toThrow("Scanned PDF OCR is limited to 25 pages.");

    expect(mocks.createWorker).not.toHaveBeenCalled();
    expect(mocks.getText).not.toHaveBeenCalled();
  });

  it("reads every page of a scan as long as the OCR page limit", async () => {
    mocks.recognize.mockResolvedValue(ocrLine(["Scanned", "page"]));

    const text = await extractDocumentText({ body: pdfFile(Array.from({ length: 25 }, () => null)), contentType: pdf });

    expect(mocks.recognize).toHaveBeenCalledTimes(25);
    expect(text).toMatch(/^\[Page 25 of 25, read by OCR\]\nScanned page$/mu);
  });

  it("leaves a PDF the improved reader can't read to the thread, which has the original read it in a new one", async () => {
    await expect(extractDocumentText({ body: new TextEncoder().encode("%PDF-1.4\nbroken\n"), contentType: pdf })).rejects.toThrow("Invalid PDF structure.");

    expect(mocks.getText).not.toHaveBeenCalled();
  });

  it("reads with the original reader when KNOWLEDGE_PDF_READER is original or default", async () => {
    mocks.getText.mockResolvedValue({ text: "Fused $25,0002", total: 1 });
    for (const value of ["original", "default"]) {
      vi.stubEnv("KNOWLEDGE_PDF_READER", value);
      await expect(extractDocumentText({ body: fixture("notes.pdf"), contentType: pdf })).resolves.toBe("Fused $25,0002");
    }
    expect(mocks.getText).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported content types", async () => {
    await expect(extractDocumentText({ body: new Uint8Array(), contentType: "application/octet-stream" })).rejects.toThrow("Unsupported knowledge document content type");
  });
});
