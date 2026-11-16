import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { crc32, createDeflate, deflateRawSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import { assertDocxInflatesWithin, extractDocumentTextInChildProcess } from "./documentExtraction";

const children = vi.hoisted(() => ({ env: [] as unknown[] }));

// Records each extraction process's environment, then starts the real process.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    fork: (...args: Parameters<typeof actual.fork>) => {
      children.env.push(args[2]?.env);
      return actual.fork(...args);
    },
  };
});

// Only Linux reports a process's resident size, so only there is the memory cap enforced.
const readsProcessMemory = existsSync("/proc/self/status");

/** A PDF of one page whose content stream is this many MB of spaces, compressed. */
async function inflatingPdf(mb: number): Promise<Uint8Array> {
  const deflate = createDeflate({ level: 9 });
  const compressed: Buffer[] = [];
  deflate.on("data", (chunk: Buffer) => compressed.push(chunk));
  const ended = once(deflate, "end");
  const block = Buffer.alloc(1024 * 1024, 0x20);
  for (let written = 0; written < mb; written += 1) if (!deflate.write(block)) await once(deflate, "drain");
  deflate.end();
  await ended;
  const stream = Buffer.concat(compressed);
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >> endobj\n4 0 obj << /Length ${stream.length} /Filter /FlateDecode >> stream\n`),
    stream,
    Buffer.from("\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n"),
  ]);
}

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

describe("extraction process", () => {
  it("returns the text extracted in the other process", async () => {
    await expect(extractDocumentTextInChildProcess({ body: docxFile("<w:p><w:r><w:t>Open daily</w:t></w:r></w:p>"), contentType: docx }, () => undefined)).resolves.toBe("Open daily\n\n");
  });

  it("carries a full-size upload and the text it becomes between the processes", async () => {
    const body = new TextEncoder().encode("Open daily. ".repeat(1_600_000));
    expect(body.byteLength).toBeGreaterThan(18 * 1024 * 1024);
    await expect(extractDocumentTextInChildProcess({ body, contentType: "text/plain" }, () => undefined)).resolves.toHaveLength(body.byteLength);
  }, 60_000);

  it("rejects a .docx that exhausts the heap instead of crashing the worker", async () => {
    const bomb = docxFile("<w:p/>".repeat(500_000));
    expect(bomb.length).toBeLessThan(10_000);
    await expect(extractDocumentTextInChildProcess({ body: bomb, contentType: docx }, () => undefined, { maxHeapMb: 64, maxMemoryMb: 2048, timeoutMs: 30_000 })).rejects.toThrow(/memory limit/);
    // How long V8 collects before it gives up at its limit varies with what else the machine is doing:
    // half a second alone, over five on a busy CI runner. The child is allowed 30, so the test waits longer.
  }, 60_000);

  // AUDIT-025: a worker thread's heap limit doesn't cover the ArrayBuffers a PDF's inflated streams
  // live in, so before this cap a 0.5 MB file like this one took the process past 1,200 MB.
  it.skipIf(!readsProcessMemory)("stops a PDF whose streams inflate past the memory cap", async () => {
    const bomb = await inflatingPdf(512);
    expect(bomb.byteLength).toBeLessThan(2 * 1024 * 1024);
    await expect(extractDocumentTextInChildProcess({ body: bomb, contentType: "application/pdf" }, () => undefined, { maxHeapMb: 512, maxMemoryMb: 400, timeoutMs: 90_000 })).rejects.toThrow("reached its 400 MB memory limit");
  }, 120_000);

  it("caps what a .docx unpacks to, even when its zip hides entries the way JSZip still reads them", () => {
    const file = Buffer.from(docxFile("<w:p/>".repeat(10_000)));
    expect(() => assertDocxInflatesWithin(file, 1_000_000)).not.toThrow();
    expect(() => assertDocxInflatesWithin(file, 1_000)).toThrow("unpacks to more than 1000 bytes");
    // JSZip shifts every offset past prepended bytes and ignores the end record's entry count.
    const prefixed = Buffer.concat([Buffer.alloc(64), file]);
    prefixed.writeUInt16LE(0, prefixed.length - 22 + 10);
    expect(() => assertDocxInflatesWithin(prefixed, 1_000)).toThrow("unpacks to more than 1000 bytes");
  });

  it("reads a PDF in the other process with the improved reader", async () => {
    const fees = new Uint8Array(readFileSync(new URL("./__fixtures__/fees.pdf", import.meta.url)));
    const text = await extractDocumentTextInChildProcess({ body: fees, contentType: "application/pdf" }, () => undefined);
    expect(text).toMatch(/^\[Page 1 of 2\]$/mu);
    expect(text).toContain("44 | 604 | 103 | $631.88 | $228.25 | $860.13");
  });

  it("reads a PDF the improved reader can't read again with the original reader, in a new process", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    children.env.length = 0;
    try {
      const broken = new TextEncoder().encode("%PDF-1.4\nbroken\n");
      const error = await extractDocumentTextInChildProcess({ body: broken, contentType: "application/pdf" }, () => undefined).catch((caught: unknown) => caught);

      // Read in the improved reader's process, pdf-parse's pdf.js 5 refuses pdf.js 6's worker code: "The API version ... does not match".
      expect(String(error)).toContain("Invalid PDF structure.");
      expect(String(error)).not.toContain("does not match");
      expect(children.env).toHaveLength(2);
      expect((children.env[1] as NodeJS.ProcessEnv).KNOWLEDGE_PDF_READER).toBe("original");
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({ event: "knowledge.pdf_reader_fallback", message: "Invalid PDF structure." });
    } finally {
      warn.mockRestore();
    }
  });

  it("treats a PDF without a text layer as a scan", async () => {
    const pages = Array.from({ length: 26 }, (_, index) => `${index + 3} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj`);
    const pdf = `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [${pages.map((_, index) => `${index + 3} 0 R`).join(" ")}] /Count 26 >> endobj\n${pages.join("\n")}\ntrailer << /Root 1 0 R >>\n%%EOF\n`;
    await expect(extractDocumentTextInChildProcess({ body: new TextEncoder().encode(pdf), contentType: "application/pdf" }, () => undefined)).rejects.toThrow("Scanned PDF OCR is limited to 25 pages.");
  });
});
