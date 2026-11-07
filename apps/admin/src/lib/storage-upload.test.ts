import { afterEach, describe, expect, it, vi } from "vitest";

const captureBrowserError = vi.hoisted(() => vi.fn());
vi.mock("./browser-error-reporting", () => ({ captureBrowserError }));

import { uploadKnowledgeDocument, uploadToStorage } from "./storage-upload";

const upload = { url: "https://bucket.storage.example/business/knowledge/file.pdf?X-Amz-Signature=secret", headers: { "content-type": "application/pdf" } };
const file = new File(["%PDF"], "file.pdf", { type: "application/pdf" });

afterEach(() => { vi.unstubAllGlobals(); captureBrowserError.mockReset(); });

describe("uploadToStorage", () => {
  it("reports a blocked request and shows the operator the translated message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(uploadToStorage(upload, file, "We couldn't upload that document.")).rejects.toThrow("We couldn't upload that document.");
    expect(captureBrowserError).toHaveBeenCalledWith(expect.objectContaining({ message: "Storage upload to bucket.storage.example failed without a response: Failed to fetch" }));
  });

  it("reports a rejected upload with its status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied", { status: 403 })));

    await expect(uploadToStorage(upload, file, "Upload failed.")).rejects.toThrow("Upload failed.");
    expect(captureBrowserError).toHaveBeenCalledWith(expect.objectContaining({ message: "Storage upload to bucket.storage.example failed with HTTP 403." }));
  });

  it("sends the file with the presigned headers and reports nothing on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadToStorage(upload, file, "Upload failed.");

    expect(fetchMock).toHaveBeenCalledWith(upload.url, { method: "PUT", headers: upload.headers, body: file });
    expect(captureBrowserError).not.toHaveBeenCalled();
  });
});

describe("uploadKnowledgeDocument", () => {
  function stubUpload() {
    vi.stubGlobal("crypto", { subtle: { digest: async () => new Uint8Array(32).fill(7).buffer } });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/uploads" && init?.method === "POST") return Response.json({ objectId: "object-1", url: upload.url, headers: upload.headers });
      if (url === upload.url) return new Response(null, { status: 200 });
      return Response.json({ document: { id: "document-1" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const finalized = () => JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url === "/api/uploads" && init?.method === "PUT")![1]!.body));
    return { fetchMock, finalized };
  }

  it("reserves, sends and finalizes a file for everyone without naming an audience", async () => {
    const { fetchMock, finalized } = stubUpload();
    await uploadKnowledgeDocument({ businessId: "business", file, contentType: "application/pdf", title: "Price list", tags: ["pricing"] }, "Upload failed.");
    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual(["POST /api/uploads", `PUT ${upload.url}`, "PUT /api/uploads"]);
    expect(finalized()).toEqual({ businessId: "business", objectId: "object-1", length: file.size, contentType: "application/pdf", checksum: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))), title: "Price list", tags: ["pricing"] });
    const everyone = stubUpload();
    await uploadKnowledgeDocument({ businessId: "business", file, contentType: "application/pdf", audience: { audience: "everyone" } }, "Upload failed.");
    expect(everyone.finalized()).not.toHaveProperty("audience");
  });

  it("finalizes a file for chosen receptionists with them, so it's never for everyone in between", async () => {
    const { fetchMock, finalized } = stubUpload();
    await uploadKnowledgeDocument({ businessId: "business", file, contentType: "application/pdf", audience: { audience: "chosen", receptionistIds: ["00000000-0000-4000-8000-0000000000a2"] } }, "Upload failed.");
    expect(finalized()).toMatchObject({ audience: "chosen", receptionistIds: ["00000000-0000-4000-8000-0000000000a2"] });
    // Reserving the object says nothing about who the file is for.
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).not.toHaveProperty("audience");
  });
});
