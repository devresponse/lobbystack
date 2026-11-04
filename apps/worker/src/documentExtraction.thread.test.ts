import { readFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import { assertDocxInflatesWithin, extractDocumentTextInThread } from "./documentExtraction";

const threads = vi.hoisted(() => ({ env: [] as unknown[] }));

// Records each thread's environment, then starts the real thread.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class Worker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      threads.env.push(args[1]?.env);
      super(...args);
    }
  }
  return { ...actual, Worker };
});

const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// The smallest .docx mammoth reads: a zip holding only word/document.xml.
function docxFile(body: string): Uint8Array {
  const raw = Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  const data = deflateRawSync(raw);
  const name = Buffer.from("word/document.xml");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(raw), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  local.copy(central, 6, 4, 30);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12);
  end.writeUInt32LE(30 + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

describe("extraction thread", () => {
  it("returns the text extracted in the thread", async () => {
    await expect(extractDocumentTextInThread({ body: docxFile("<w:p><w:r><w:t>Open daily</w:t></w:r></w:p>"), contentType: docx }, () => undefined)).resolves.toBe("Open daily\n\n");
  });

  it("rejects a .docx that exhausts the thread heap instead of crashing the process", async () => {
    const bomb = docxFile("<w:p/>".repeat(500_000));
    expect(bomb.length).toBeLessThan(10_000);
    await expect(extractDocumentTextInThread({ body: bomb, contentType: docx }, () => undefined, { maxHeapMb: 64, timeoutMs: 30_000 })).rejects.toThrow(/memory limit/);
  });

  it("caps what a .docx unpacks to, even when its zip hides entries the way JSZip still reads them", () => {
    const file = Buffer.from(docxFile("<w:p/>".repeat(10_000)));
    expect(() => assertDocxInflatesWithin(file, 1_000_000)).not.toThrow();
    expect(() => assertDocxInflatesWithin(file, 1_000)).toThrow("unpacks to more than 1000 bytes");
    // JSZip shifts every offset past prepended bytes and ignores the end record's entry count.
    const prefixed = Buffer.concat([Buffer.alloc(64), file]);
    prefixed.writeUInt16LE(0, prefixed.length - 22 + 10);
    expect(() => assertDocxInflatesWithin(prefixed, 1_000)).toThrow("unpacks to more than 1000 bytes");
  });

  it("reads a PDF in the thread with the improved reader", async () => {
    const fees = new Uint8Array(readFileSync(new URL("./__fixtures__/fees.pdf", import.meta.url)));
    const text = await extractDocumentTextInThread({ body: fees, contentType: "application/pdf" }, () => undefined);
    expect(text).toMatch(/^\[Page 1 of 2\]$/mu);
    expect(text).toContain("44 | 604 | 103 | $631.88 | $228.25 | $860.13");
  });

  it("reads a PDF the improved reader can't read again with the original reader, in a new thread", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    threads.env.length = 0;
    try {
      const broken = new TextEncoder().encode("%PDF-1.4\nbroken\n");
      const error = await extractDocumentTextInThread({ body: broken, contentType: "application/pdf" }, () => undefined).catch((caught: unknown) => caught);

      // Read in the improved reader's thread, pdf-parse's pdf.js 5 refuses pdf.js 6's worker code: "The API version ... does not match".
      expect(String(error)).toContain("Invalid PDF structure.");
      expect(String(error)).not.toContain("does not match");
      expect(threads.env).toHaveLength(2);
      expect((threads.env[1] as NodeJS.ProcessEnv).KNOWLEDGE_PDF_READER).toBe("original");
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({ event: "knowledge.pdf_reader_fallback", message: "Invalid PDF structure." });
    } finally {
      warn.mockRestore();
    }
  });

  it("treats a PDF without a text layer as a scan", async () => {
    const pages = Array.from({ length: 12 }, (_, index) => `${index + 3} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj`);
    const pdf = `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [${pages.map((_, index) => `${index + 3} 0 R`).join(" ")}] /Count 12 >> endobj\n${pages.join("\n")}\ntrailer << /Root 1 0 R >>\n%%EOF\n`;
    await expect(extractDocumentTextInThread({ body: new TextEncoder().encode(pdf), contentType: "application/pdf" }, () => undefined)).rejects.toThrow("Scanned PDF OCR is limited to 10 pages.");
  });
});
