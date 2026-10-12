import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeConfig } from "./config";
import { exitCodes } from "./errors";
import { BUSINESS, KEY, fakeApi, runCli, tempDir } from "./testing";

const week = [
  { day: "monday", open: "09:00", close: "17:00" },
  { day: "tuesday", open: "09:00", close: "17:00" },
  { day: "saturday", open: "10:00", close: "14:00" },
];

describe("hours", () => {
  it("changes only the days named and sends the rest of the week as it was", async () => {
    const api = fakeApi({
      "GET /api/v1/business": { body: { data: { id: BUSINESS, hours: week } } },
      "PATCH /api/v1/business": (request) => ({ body: { data: { id: BUSINESS, hours: (request.body as { hours: unknown }).hours } } }),
    });
    const result = await runCli(["hours", "set", "--tuesday", "08:00-12:00,13:00-18:00", "--saturday", "closed"], { fetch: api.fetch });
    expect(result.code).toBe(exitCodes.ok);
    expect(api.sent[1]!.body).toEqual({ hours: [
      { day: "monday", open: "09:00", close: "17:00" },
      { day: "tuesday", open: "08:00", close: "12:00" },
      { day: "tuesday", open: "13:00", close: "18:00" },
    ] });
    expect(result.out).toMatch(/tuesday\s+08:00-12:00, 13:00-18:00/);
    expect(result.out).toMatch(/saturday\s+closed/);
    expect((await runCli(["hours", "set", "--monday", "9-5"], { fetch: api.fetch })).code).toBe(exitCodes.invalid);
    expect((await runCli(["hours", "set"], { fetch: api.fetch })).code).toBe(exitCodes.invalid);
  });
});

describe("business use", () => {
  it("checks the key can act on the business, then saves it in the profile", async () => {
    const dir = await tempDir();
    try {
      const path = join(dir.path, "lobbystack", "config.json");
      await writeConfig(path, { current: "default", profiles: { default: { url: "https://app.example.com", key: KEY } } });
      const api = fakeApi({ "GET /api/v1/business": { body: { data: { id: BUSINESS, name: "Acme Dental" } } } });
      const result = await runCli(["business", "use", BUSINESS], { fetch: api.fetch, configHome: dir.path, env: { LOBBYSTACK_URL: "", LOBBYSTACK_API_KEY: "", LOBBYSTACK_BUSINESS: "" } });
      expect(result).toMatchObject({ code: exitCodes.ok, out: `The default profile now acts on Acme Dental (${BUSINESS}).` });
      expect(api.sent[0]!.headers["LobbyStack-Business"]).toBe(BUSINESS);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ current: "default", profiles: { default: { url: "https://app.example.com", key: KEY, business: BUSINESS } } });
      // A business the key can't act on isn't saved.
      const refused = fakeApi({ "GET /api/v1/business": { status: 404, body: { error: { code: "not_found", message: "Business not found." } } } });
      const other = "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6";
      expect(await runCli(["business", "use", other], { fetch: refused.fetch, configHome: dir.path, env: { LOBBYSTACK_URL: "", LOBBYSTACK_API_KEY: "", LOBBYSTACK_BUSINESS: "" } })).toMatchObject({ code: exitCodes.invalid, err: "Business not found." });
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ profiles: { default: { business: BUSINESS } } });
      // With the environment's pair there's no profile to save into.
      expect(await runCli(["business", "use", BUSINESS], { fetch: api.fetch, configHome: dir.path })).toMatchObject({ code: exitCodes.invalid, err: expect.stringContaining("Set LOBBYSTACK_BUSINESS instead.") });
      expect((await runCli(["business", "use", "acme"], { configHome: dir.path })).code).toBe(exitCodes.invalid);
    } finally {
      await dir.remove();
    }
  });
});

describe("knowledge upload", () => {
  it("reserves the upload, sends the bytes to its URL without the key, then completes it", async () => {
    const dir = await tempDir();
    try {
      const file = join(dir.path, "prices.pdf");
      await writeFile(file, "%PDF-1.7 prices");
      const uploadId = "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6";
      const api = fakeApi({
        "POST /api/v1/knowledge/uploads": { status: 201, body: { data: { upload_id: uploadId, upload_url: "https://storage.example.net/put?signature=x", upload_headers: { "content-type": "application/pdf" }, expires_at: null } } },
        "PUT https://storage.example.net/put?signature=x": { status: 200 },
        [`POST /api/v1/knowledge/uploads/${uploadId}/complete`]: { status: 202, body: { data: { id: uploadId, type: "file", title: "Prices", status: "pending" } } },
        [`GET /api/v1/knowledge/sources/${uploadId}`]: { body: { data: { id: uploadId, type: "file", title: "Prices", status: "indexed" } } },
      });
      const result = await runCli(["knowledge", "upload", file, "--title", "Prices", "--tags", "pricing,2026", "--wait", "--json"], { fetch: api.fetch });
      expect(result.code).toBe(exitCodes.ok);
      expect(JSON.parse(result.out)).toMatchObject({ status: "indexed" });
      expect(api.sent[0]!.body).toEqual({ file_name: "prices.pdf", content_type: "application/pdf", length: 15, checksum_sha256: createHash("sha256").update("%PDF-1.7 prices").digest("base64") });
      expect(api.sent[1]).toMatchObject({ method: "PUT", headers: { "content-type": "application/pdf" }, redirect: "error" });
      expect(api.sent[1]!.headers).not.toHaveProperty("authorization");
      expect(api.sent[2]!.body).toEqual({ title: "Prices", tags: ["pricing", "2026"] });

      // A relative upload URL, as local storage gives, goes to the dashboard's own address, still without the key.
      const local = fakeApi({
        "POST /api/v1/knowledge/uploads": { status: 201, body: { data: { upload_id: uploadId, upload_url: "/api/storage/local?token=signed", upload_headers: { "content-type": "application/pdf" }, expires_at: null } } },
        "PUT /api/storage/local": { status: 200 },
        [`POST /api/v1/knowledge/uploads/${uploadId}/complete`]: { status: 202, body: { data: { id: uploadId, type: "file", status: "pending" } } },
        [`GET /api/v1/knowledge/sources/${uploadId}`]: { body: { data: { id: uploadId, type: "file", status: "error", error: "The file has no text in it" } } },
      });
      const failed = await runCli(["knowledge", "upload", file, "--wait"], { fetch: local.fetch });
      expect(local.sent[1]).toMatchObject({ method: "PUT", path: "/api/storage/local", query: { token: "signed" } });
      expect(local.sent[1]!.headers).not.toHaveProperty("authorization");
      expect(failed).toMatchObject({ code: exitCodes.failed, err: "Reading it failed: The file has no text in it." });

      await writeFile(join(dir.path, "notes.exe"), "x");
      expect(await runCli(["knowledge", "upload", join(dir.path, "notes.exe")], { fetch: api.fetch })).toMatchObject({ code: exitCodes.invalid, err: expect.stringContaining("isn't a type the receptionist reads") });
    } finally {
      await dir.remove();
    }
  });
});
