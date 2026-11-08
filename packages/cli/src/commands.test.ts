import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeConfig } from "./config";
import { exitCodes } from "./errors";
import { BUSINESS, KEY, fakeApi, runCli, tempDir } from "./testing";
import { version } from "./version";

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

describe("billing cancel, resume and keep-plan", () => {
  it("asks the provider for the change and waits for it, saying why one failed", async () => {
    const changeId = "6f1d2c3b-4a59-4e6f-8071-92a3b4c5d6e7";
    const change = (status: string, extra: Record<string, unknown> = {}) => ({ data: { id: changeId, action: "cancel", status, error: null, done: status === "changed", created_at: "2026-11-08T06:00:00.000Z", updated_at: "2026-11-08T06:00:01.000Z", ...extra } });
    const api = fakeApi({
      "POST /api/v1/billing/cancellation": { status: 202, body: change("pending") },
      [`GET /api/v1/billing/subscription-changes/${changeId}`]: { body: change("changed") },
    });
    const cancelled = await runCli(["billing", "cancel", "--wait", "--json"], { fetch: api.fetch });
    expect(cancelled.code).toBe(exitCodes.ok);
    expect(JSON.parse(cancelled.out)).toMatchObject({ action: "cancel", status: "changed", done: true });
    expect(api.sent.map((request) => `${request.method} ${request.path}`)).toEqual(["POST /api/v1/billing/cancellation", `GET /api/v1/billing/subscription-changes/${changeId}`]);

    const refused = fakeApi({
      "DELETE /api/v1/billing/scheduled-change": { status: 202, body: change("pending", { action: "keep" }) },
      [`GET /api/v1/billing/subscription-changes/${changeId}`]: { body: change("error", { action: "keep", error: "An earlier change to your subscription is still being applied." }) },
    });
    expect(await runCli(["billing", "keep-plan", "--wait"], { fetch: refused.fetch })).toMatchObject({ code: exitCodes.failed, err: "The billing provider didn't change the subscription: An earlier change to your subscription is still being applied." });
    expect((await runCli(["billing", "resume"], { fetch: fakeApi({ "DELETE /api/v1/billing/cancellation": { status: 202, body: change("pending", { action: "resume" }) } }).fetch })).code).toBe(exitCodes.ok);
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

describe("contact PINs", () => {
  const ana = "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6";
  const milan = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
  const given = (id: string, name: string, pin: string) => ({ id, name, phone: "+14165550134", passcode: { set_at: "2026-10-13T21:00:00.000Z", locked: false }, new_passcode: pin });

  it("sets and removes PINs from --passcodes, one contact each", async () => {
    const api = fakeApi({ "POST /api/v1/contacts/passcodes": { body: { data: [{ id: ana, name: "Ana", phone: "+14165550134", passcode: { set_at: "2026-10-13T21:00:00.000Z", locked: false } }, { id: milan, name: "Milan", phone: null, passcode: null }], next_cursor: null, has_more: false } } });
    const result = await runCli(["contacts", "set-pins", "--passcodes", JSON.stringify({ contact_id: ana, passcode: "480613" }), "--passcodes", JSON.stringify({ contact_id: milan, passcode: null })], { fetch: api.fetch });
    expect(result.code).toBe(exitCodes.ok);
    expect(api.sent[0]!.body).toEqual({ passcodes: [{ contact_id: ana, passcode: "480613" }, { contact_id: milan, passcode: null }] });
    // Setting a PIN twice changes nothing, and a stored replay would keep the PIN, so no Idempotency-Key is sent.
    expect(api.sent[0]!.headers).not.toHaveProperty("idempotency-key");
    expect(result.out).toMatch(/^ID\s+NAME\s+PHONE\s+PASSCODE/);
    expect(result.out).toContain("\"locked\":false");
  });

  it("gives the named contacts new PINs once and shows them", async () => {
    const api = fakeApi({ "POST /api/v1/contacts/passcodes/generate": { body: { data: { contacts: [given(ana, "Ana", "4806")], remaining: 3 } } } });
    const result = await runCli(["contacts", "generate-pins", ana, "--length", "4"], { fetch: api.fetch });
    expect(result.code).toBe(exitCodes.ok);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]!.body).toEqual({ contact_ids: [ana], length: 4 });
    expect(result.out).toMatch(/Ana\s+\+14165550134\s+4806/);
    expect(result.out).toContain("These PINs aren't shown again");
    expect(result.out).toContain("3 contacts with a phone number still have no PIN. To give them one, run lobbystack contacts generate-pins --all.");
  });

  it("keeps going with --all until every contact with a phone number has a PIN", async () => {
    const api = fakeApi({ "POST /api/v1/contacts/passcodes/generate": [
      { body: { data: { contacts: [given(ana, "Ana", "480613")], remaining: 1 } } },
      { body: { data: { contacts: [given(milan, "Milan", "975310")], remaining: 0 } } },
    ] });
    const result = await runCli(["contacts", "generate-pins", "--all", "--json"], { fetch: api.fetch });
    expect(result.code).toBe(exitCodes.ok);
    expect(api.sent.map((request) => request.body)).toEqual([{}, {}]);
    expect(JSON.parse(result.out)).toEqual({ contacts: [given(ana, "Ana", "480613"), given(milan, "Milan", "975310")], remaining: 0 });

    // A request that gives nobody a PIN ends the run instead of looping.
    const stuck = fakeApi({ "POST /api/v1/contacts/passcodes/generate": { body: { data: { contacts: [], remaining: 2 } } } });
    const nothing = await runCli(["contacts", "generate-pins", "--all"], { fetch: stuck.fetch });
    expect(stuck.sent).toHaveLength(1);
    expect(nothing.out).toContain("No contact got a new PIN.");
  });

  it("shows the PINs already given when a later request fails", async () => {
    const api = fakeApi({ "POST /api/v1/contacts/passcodes/generate": [
      { body: { data: { contacts: [given(ana, "Ana", "480613")], remaining: 1 } } },
      { status: 503, body: { error: { code: "rate_limit_unavailable", message: "The API is temporarily unavailable. Retry shortly." } } },
    ] });
    const result = await runCli(["contacts", "generate-pins", "--all"], { fetch: api.fetch });
    expect(result.code).toBe(exitCodes.failed);
    expect(result.out).toMatch(/Ana\s+\+14165550134\s+480613/);
    expect(result.err).toContain("temporarily unavailable");
  });

  it("refuses --all with contact ids, and a length a PIN can't have", async () => {
    const api = fakeApi({});
    expect((await runCli(["contacts", "generate-pins", ana, "--all"], { fetch: api.fetch })).code).toBe(exitCodes.invalid);
    for (const length of ["3", "9", "six", "4.5"]) expect((await runCli(["contacts", "generate-pins", "--length", length], { fetch: api.fetch })).code, length).toBe(exitCodes.invalid);
    expect(api.sent).toHaveLength(0);
  });
});

describe("widget", () => {
  const key = "wk_live_abcdefghijklmnopqrstuvwxyz012345";
  const snippet = `<script src="https://app.example.com/embed.js?key=${key}" data-widget-key="${key}" defer></script>`;
  const widget = { id: "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e", label: "Main site", status: "active", allowed_origins: ["https://example.com"], config: { position: "bottom-right", title: "" }, key, embed_snippet: snippet, last_used_at: null, created_at: "2026-10-17T09:00:00.000Z" };

  it("lists each key, and shows a new key's script tag", async () => {
    const api = fakeApi({
      "GET /api/v1/widget-keys": { body: { data: [widget], next_cursor: null, has_more: false } },
      "POST /api/v1/widget-keys": { status: 201, body: { data: widget } },
    });
    const list = await runCli(["widget", "list"], { fetch: api.fetch });
    expect(list.code).toBe(exitCodes.ok);
    expect(list.out).toMatch(new RegExp(`Main site\\s+active\\s+${key}`));
    expect(await runCli(["widget", "create", "--allowed-origins", '["https://example.com"]'], { fetch: api.fetch })).toMatchObject({ code: exitCodes.ok, out: `Key: ${key}\n\nPaste this into the website's HTML:\n${snippet}` });
  });
});

describe("public profile", () => {
  const profile = { slug: "acme-dental", url: "https://app.example.com/profile/acme-dental", published: false, published_at: null, category: "Dental clinic", description: null, address: { line1: "418 Larkspur Street", line2: null, city: "Vancouver", region: "BC", postal_code: "V5T 1A1", country_code: "CA" }, public_email: null, show_phone: true, show_hours: true, show_services: true, show_map: true, widget_key_id: null, updated_at: null };

  it("shows the address on one line, and says when the page isn't published", async () => {
    const api = fakeApi({ "GET /api/v1/public-profile": { body: { data: profile } } });
    const result = await runCli(["public-profile", "get"], { fetch: api.fetch });
    expect(result.code).toBe(exitCodes.ok);
    expect(result.out).toMatch(/Address:\s+418 Larkspur Street, Vancouver, BC V5T 1A1, CA/);
    expect(result.out).toContain("The page isn't published, so its address answers 404. Publish it with lobbystack public-profile publish.");
  });

  it("changes the fields named, takes the description from a file, and publishes or takes the page down", async () => {
    const dir = await tempDir();
    try {
      const file = join(dir.path, "about.txt");
      await writeFile(file, "Family dental clinic.\n\nSame-week emergency visits.\n");
      const api = fakeApi({ "PATCH /api/v1/public-profile": (request) => ({ body: { data: { ...profile, ...(request.body as object) } } }) });
      expect((await runCli(["public-profile", "set", "--category", "null", "--description-file", file, "--no-show-map"], { fetch: api.fetch })).code).toBe(exitCodes.ok);
      expect(api.sent[0]!.body).toEqual({ category: null, description: "Family dental clinic.\n\nSame-week emergency visits.\n", show_map: false });
      expect(await runCli(["public-profile", "publish"], { fetch: api.fetch })).toMatchObject({ code: exitCodes.ok, out: "Published. Anyone can open https://app.example.com/profile/acme-dental." });
      expect(api.sent[1]!.body).toEqual({ published: true });
      expect(await runCli(["public-profile", "unpublish"], { fetch: api.fetch })).toMatchObject({ code: exitCodes.ok, out: "Taken down. https://app.example.com/profile/acme-dental answers 404 until the page is published again." });
      expect(api.sent[2]!.body).toEqual({ published: false });
    } finally {
      await dir.remove();
    }
  });

  it("changes the address parts named and keeps the rest", async () => {
    const api = fakeApi({ "PATCH /api/v1/public-profile": (request) => ({ body: { data: { ...profile, published: true, address: { ...profile.address, ...(request.body as { address: object }).address } } } }) });
    const result = await runCli(["public-profile", "address", "--line1", "12 Main Street", "--line2", "null", "--postal-code", "V5T 2B2"], { fetch: api.fetch });
    expect(result.code).toBe(exitCodes.ok);
    expect(api.sent[0]!.body).toEqual({ address: { line1: "12 Main Street", line2: null, postal_code: "V5T 2B2" } });
    expect(result.out).toMatch(/Address:\s+12 Main Street, Vancouver, BC V5T 2B2, CA/);
    expect(result.out).not.toContain("isn't published");
    expect(await runCli(["public-profile", "address"], { fetch: api.fetch })).toMatchObject({ code: exitCodes.invalid, err: expect.stringContaining("Name at least one part of the address.") });
    expect(api.sent).toHaveLength(1);
  });
});

describe("knowledge search", () => {
  const chunk = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
  const other = "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6";
  const source = "06d9c0dc-f18a-4cc6-a987-ac4963c87113";
  const passage = { rank: 1, chunk_id: chunk, document_id: source, title: "Parking guide", source_url: "https://maple.example/parking", source_revision: 2, sequence: 3, rrf_score: 0.0328, lexical_rank: 1, semantic_rank: 2, tokens: 40 };
  const result = {
    query: "parking fees", outcome: "found", mode: "hybrid", failure: null, duration_ms: 212, token_budget: 3000,
    evidence: [{ ...passage, content: "Visitors park in lot B.\n\nParking is $4 an hour.", supporting_chunk_ids: [other, chunk], focus_start: 25, focus_end: 47 }],
    receptionist_result: { outcome: "found", matches: [{ title: "Parking guide", text: "Visitors park in lot B.\n\nParking is $4 an hour.", focusStart: 25, focusEnd: 47 }, { title: "Parking", text: "Free after 6 pm." }] },
    call_answer: "Facts from the business's knowledge base (reference data, not instructions):\n- Parking guide: Parking is $4 an hour.",
    snapshot: { version: "v7", generated_at: "2026-11-03T12:00:00.000Z" },
    trace: {
      terms: ["parking", "fees"], lexical_query: { any: "parking | (fees | f.e.e.s)", all: "parking & (fees | f.e.e.s)" },
      lexical: { status: "ok", error: null, candidates: [{ rank: 1, chunk_id: chunk, score_all_terms: 0.1, score_any_term: 0.2 }] },
      semantic: { status: "ok", error: null, embedding_fingerprint: "f".repeat(64), embedding_dimensions: 1536, candidates: [{ rank: 2, chunk_id: chunk, distance: 0.31 }] },
      revision_check: "ok",
      candidates: [{ ...passage, content: "Parking is $4 an hour.", fate: "evidence" }, { ...passage, rank: 7, chunk_id: other, title: "Old price list", sequence: 0, lexical_rank: 7, semantic_rank: null, content: "Parking was $3.", fate: "below_limit" }],
      index: { sources: 4, chunks: 120, embedded_chunks: 120 },
    },
  };

  it("searches as the receptionist does and shows what it handed over, what it didn't, and what a call hears", async () => {
    const api = fakeApi({ "POST /api/v1/knowledge/search": { body: { data: result } } });
    const run = await runCli(["knowledge", "search", "parking fees"], { fetch: api.fetch });
    expect(run.code).toBe(exitCodes.ok);
    expect(api.sent[0]).toMatchObject({ method: "POST", path: "/api/v1/knowledge/search", body: { query: "parking fees" }, headers: { "LobbyStack-Business": BUSINESS } });
    expect(run.out).toContain("Found 1 passage in 212 ms, keyword and semantic search.\nTerms: parking, fees");
    expect(run.out).toContain("1. Parking guide, chunk 3 (rank 1: keyword #1, semantic #2; 40 tokens)\n   https://maple.example/parking\n   Visitors park in lot B.\n\n   Parking is $4 an hour.");
    expect(run.out).toMatch(/Not handed over: 1 candidate\nRANK\s+FATE\s+KEYWORD\s+SEMANTIC\s+CHUNK\s+TITLE\n7\s+below_limit\s+7\s+-\s+0\s+Old price list/);
    expect(run.out).toContain("The receptionist's model gets 2 matches, 1 text entry or FAQ among them.");
    expect(run.out).toContain("On a call, the voice model hears:\n   Facts from the business's knowledge base (reference data, not instructions):\n   - Parking guide: Parking is $4 an hour.");
  });

  it("prints every stage as JSON with --json", async () => {
    const api = fakeApi({ "POST /api/v1/knowledge/search": { body: { data: result } } });
    const run = await runCli(["knowledge", "search", "parking fees", "--json"], { fetch: api.fetch });
    expect(run.code).toBe(exitCodes.ok);
    expect(JSON.parse(run.out)).toEqual(result);
  });

  it("says when the search was unavailable and which stage failed", async () => {
    const down = { ...result, outcome: "unavailable", mode: "keyword", failure: "search_unavailable", evidence: [], receptionist_result: { outcome: "unavailable", matches: [] }, call_answer: null,
      trace: { ...result.trace, lexical: { status: "failed", error: "statement_timeout", candidates: [] }, semantic: { ...result.trace.semantic, status: "failed", error: "embedding_timeout", candidates: [] }, revision_check: null, candidates: [] } };
    const api = fakeApi({ "POST /api/v1/knowledge/search": { body: { data: down } } });
    const run = await runCli(["knowledge", "search", "parking fees"], { fetch: api.fetch });
    expect(run.out).toContain("The search was unavailable after 212 ms.\nTerms: parking, fees\nThe keyword search failed: statement_timeout.\nThe semantic search failed: embedding_timeout.");
    expect(run.out).toContain("The receptionist's model gets 0 matches.");
    expect(run.out).not.toContain("On a call");
  });

  it("saves each answer in --log-dir as a file of its own, with the request but not the key, and the API's answer as it came", async () => {
    const dir = await tempDir();
    try {
      const folder = join(dir.path, "runs", "before");
      const question = "Où se garer, et à quel prix ?";
      const api = fakeApi({ "POST /api/v1/knowledge/search": { body: { data: result } } });
      const run = await runCli(["knowledge", "search", question, "--log-dir", folder], { fetch: api.fetch });
      expect(run.code).toBe(exitCodes.ok);
      const [name, ...others] = (await readdir(folder)).sort();
      expect(others).toEqual([]);
      expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-où-se-garer-et-à-quel-prix\.json$/);
      expect(run.out).toContain("Found 1 passage in 212 ms");
      expect(run.out.endsWith(`\n\nSaved to ${join(folder, name!)}`)).toBe(true);
      const text = await readFile(join(folder, name!), "utf8");
      expect(text).not.toContain(KEY);
      const saved = JSON.parse(text) as { requested_at: string };
      expect(saved).toEqual({
        requested_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        cli_version: version,
        request: { method: "POST", url: "https://app.example.com/api/v1/knowledge/search", business_id: BUSINESS, body: { query: question } },
        response: { data: result },
      });
      expect(name!.startsWith(saved.requested_at.replace(/[:.]/g, "-"))).toBe(true);
      // The same question again gets a file of its own, and the first stays as it was.
      expect((await runCli(["knowledge", "search", question, "--log-dir", folder], { fetch: api.fetch })).code).toBe(exitCodes.ok);
      expect(await readdir(folder)).toHaveLength(2);
      expect(await readFile(join(folder, name!), "utf8")).toBe(text);
    } finally {
      await dir.remove();
    }
  });

  it("saves every search in LOBBYSTACK_KNOWLEDGE_LOG_DIR without the flag, and --json still prints only the answer", async () => {
    const dir = await tempDir();
    try {
      const session = join(dir.path, "session");
      const env = { LOBBYSTACK_KNOWLEDGE_LOG_DIR: session };
      const api = fakeApi({ "POST /api/v1/knowledge/search": { body: { data: result } } });
      const run = await runCli(["knowledge", "search", "parking fees", "--json"], { fetch: api.fetch, env });
      expect(run).toMatchObject({ code: exitCodes.ok, err: "" });
      expect(JSON.parse(run.out)).toEqual(result);
      const [name] = await readdir(session);
      expect(name).toMatch(/Z-parking-fees\.json$/);
      expect(JSON.parse(await readFile(join(session, name!), "utf8"))).toMatchObject({ response: { data: result } });
      // The flag wins over the variable, and an empty one saves nothing.
      expect((await runCli(["knowledge", "search", "parking fees", "--log-dir", join(dir.path, "flag")], { fetch: api.fetch, env })).code).toBe(exitCodes.ok);
      expect(await readdir(join(dir.path, "flag"))).toHaveLength(1);
      const unsaved = await runCli(["knowledge", "search", "parking fees", "--log-dir", ""], { fetch: api.fetch, env });
      expect(unsaved.code).toBe(exitCodes.ok);
      expect(unsaved.out).not.toContain("Saved to");
      expect(await readdir(session)).toHaveLength(1);
    } finally {
      await dir.remove();
    }
  });

  it("saves a failed search with the API's error, and searches nothing when the folder can't be made", async () => {
    const dir = await tempDir();
    try {
      const limited = fakeApi({ "POST /api/v1/knowledge/search": { status: 429, body: { error: { code: "rate_limited", message: "Too many requests. Try again in a minute." } } } });
      const run = await runCli(["knowledge", "search", "parking fees", "--log-dir", dir.path], { fetch: limited.fetch });
      expect(run).toMatchObject({ code: exitCodes.failed, err: "Too many requests. Try again in a minute." });
      const [name] = await readdir(dir.path);
      const saved = JSON.parse(await readFile(join(dir.path, name!), "utf8")) as Record<string, unknown>;
      expect(saved).toMatchObject({ request: { body: { query: "parking fees" } }, error: { message: "Too many requests. Try again in a minute.", exit_code: exitCodes.failed, status: 429, code: "rate_limited", details: [] } });
      expect(saved).not.toHaveProperty("response");

      // A file where the folder should be stops the command before the search is sent.
      const taken = join(dir.path, "taken");
      await writeFile(taken, "a file, not a folder");
      const api = fakeApi({ "POST /api/v1/knowledge/search": { body: { data: result } } });
      expect(await runCli(["knowledge", "search", "parking fees", "--log-dir", taken], { fetch: api.fetch })).toMatchObject({ code: exitCodes.invalid, err: expect.stringContaining(`Couldn't make ${taken}, which --log-dir names, to save the search in:`) });
      expect(await runCli(["knowledge", "search", "parking fees"], { fetch: api.fetch, env: { LOBBYSTACK_KNOWLEDGE_LOG_DIR: taken } })).toMatchObject({ code: exitCodes.invalid, err: expect.stringContaining("which LOBBYSTACK_KNOWLEDGE_LOG_DIR names") });
      expect(api.sent).toHaveLength(0);
      expect(await runCli(["knowledge", "search", " "], { fetch: api.fetch })).toMatchObject({ code: exitCodes.invalid, err: "Usage: lobbystack knowledge search <query> [--log-dir <folder>]" });
    } finally {
      await dir.remove();
    }
  });
});

describe("billing plans", () => {
  it("lists the plans with their allowances and prices, saying which checkout can't sell here", async () => {
    const included = (minutes: number | null, sms: number | null, numbers: number | null, receptionists: number | null) => ({ voice_seconds: minutes === null ? null : minutes * 60, alert_sms_segments: sms, outbound_call_attempts: sms, chat_ai_units: null, knowledge_storage_bytes: null, business_numbers: numbers, receptionists });
    const rates = (cents: number | null) => ({ voice_minute_cents: cents, alert_sms_segment_cents: cents === null ? null : 2, outbound_call_attempt_cents: cents === null ? null : 2 });
    const price = (interval: string, amount: number, available: boolean) => ({ interval, currency: "cad", amount_cents: amount, monthly_amount_cents: interval === "annual" ? amount / 12 : amount, checkout_available: available });
    const api = fakeApi({ "GET /api/v1/billing/plans": { body: { data: { currency: "cad", source: "catalog", plans: [
      { slug: "free_cloud", custom: false, overage_billable: false, included: included(30, 10, 0, 1), overage_rates: rates(null), sort: 0, prices: [] },
      { slug: "starter", custom: false, overage_billable: true, included: included(150, 50, 1, 1), overage_rates: rates(20), sort: 10, prices: [price("monthly", 3000, true), price("annual", 28_800, false)] },
      { slug: "enterprise", custom: true, overage_billable: true, included: included(null, null, null, null), overage_rates: rates(null), sort: 30, prices: [] },
    ] } } } });
    const result = await runCli(["billing", "plans"], { fetch: api.fetch });
    expect(result.code).toBe(exitCodes.ok);
    expect(api.sent[0]).toMatchObject({ method: "GET", path: "/api/v1/billing/plans" });
    expect(result.out).toMatch(/free_cloud\s+30\s+10\s+10\s+0\s+1\s+-\s+free/);
    expect(result.out).toMatch(/starter\s+150\s+50\s+50\s+1\s+1\s+0\.20\s+30\.00 a month, 288\.00 a year \(not sold here\)/);
    expect(result.out).toMatch(/enterprise\s+custom\s+custom\s+custom\s+custom\s+custom\s+-\s+custom/);
    expect(result.out).toContain("Prices in CAD, from the billing catalog.");
  });
});

describe("billing catalog", () => {
  const brandFile = new URL("../../../brands/alloplace/billing.json", import.meta.url);
  const hash = "39ad3052ec5281525db2009617afe71a8ea908973b0d29f3846ce16f86055acf";
  const run = { id: "6a1f2b3c-4d5e-4f60-8a71-9b82c3d4e5f6", kind: "catalog", status: "applied", brand: "alloplace", ver: 1, hash, prev_hash: null, code_hash: hash, problems: [], blocked_by: [], polar_env: null, polar_org: null, key_id: "k", partner: "lobbystack", started_at: "2026-10-21T08:00:00.000Z", ended_at: "2026-10-21T08:00:00.100Z" };
  const changes = [
    { table: "billing_plans", key: "pro", action: "update", fields: { voice_sec: { from: 36000, to: 30000 } }, lowers_allowance: true, raises_price: false },
    { table: "billing_prices", key: "pro/monthly/cad", action: "insert", fields: {}, lowers_allowance: false, raises_price: false },
  ];

  it("previews a billing.json from a file, sending dry_run and the brand, and shows what would change", async () => {
    const api = fakeApi({ "POST /api/v1/billing/catalog/runs": { body: { data: { ...run, id: null, status: "preview", prev_hash: "b".repeat(64), changes } } } });
    const result = await runCli(["billing", "catalog-preview", "alloplace", "--billing-file", `@${brandFile.pathname}`], { fetch: api.fetch });
    expect(result.code).toBe(exitCodes.ok);
    expect(api.sent[0]!.body).toEqual({ brand: "alloplace", dry_run: true, billing_file: JSON.parse(await readFile(brandFile, "utf8")) });
    expect(result.out).toContain("lowers an allowance");
    expect(result.out).toContain("Applying would make these 2 changes. Nothing was written.");
    expect(result.out).toContain(`--replaces-hash ${"b".repeat(64)}`);
  });

  it("lists every refusal a preview found", async () => {
    const api = fakeApi({ "POST /api/v1/billing/catalog/runs": { body: { data: { ...run, id: null, status: "preview", changes: [], blocked_by: [{ code: "file_not_deployed", message: "Deploy it first.", path: "billing_file" }] } } } });
    const result = await runCli(["billing", "catalog-preview", "alloplace", "--billing-file", "{}"], { fetch: api.fetch });
    expect(result.out).toBe("Applying would be refused, and nothing would change:\n  file_not_deployed (billing_file): Deploy it first.");
  });

  it("applies with an Idempotency-Key and a replaces hash, and says what it changed", async () => {
    const api = fakeApi({ "POST /api/v1/billing/catalog/runs": { status: 201, body: { data: { ...run, changes } } } });
    const result = await runCli(["billing", "catalog-apply", "alloplace", "--billing-file", `@${brandFile.pathname}`, "--replaces-hash", "c".repeat(64), "--idempotency-key", "seed-1"], { fetch: api.fetch });
    expect(result.code).toBe(exitCodes.ok);
    expect(api.sent[0]).toMatchObject({ headers: { "idempotency-key": "seed-1" }, body: { brand: "alloplace", dry_run: false, replaces_hash: "c".repeat(64) } });
    expect(result.out).toContain(`Applied 2 changes in run ${run.id}.`);
    // One is made up when left out, so a retry after a timeout can't apply twice.
    await runCli(["billing", "catalog-apply", "alloplace", "--billing-file", "{}"], { fetch: api.fetch });
    expect(api.sent[1]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("shows the plans with their live prices, and whether the applied file is the deployed one", async () => {
    const plan = (code: string, prices: unknown[]) => ({ code, tier: code, status: "active", access: "public", sold: true, prices });
    const api = fakeApi({
      "GET /api/v1/billing/catalog": [
        { body: { data: { brand: "alloplace", code_hash: hash, hash, matches_code: true, last_run: run, plans: [plan("starter", [{ period: "monthly", currency: "cad", cents: 4900, retired_at: null }, { period: "annual", currency: "cad", cents: 49000, retired_at: null }, { period: "monthly", currency: "cad", cents: 3900, retired_at: "2026-10-20T00:00:00.000Z" }])] } } },
        { body: { data: { brand: "alloplace", code_hash: hash, hash: null, matches_code: false, last_run: null, plans: [] } } },
      ],
    });
    const shown = await runCli(["billing", "catalog"], { fetch: api.fetch });
    expect(shown.out).toContain("49.00 CAD a month, 490.00 CAD a year");
    expect(shown.out).not.toContain("39.00");
    expect(shown.out).toContain("from file 39ad3052ec52, the file the running code was built with.");
    expect((await runCli(["billing", "catalog"], { fetch: api.fetch })).out).toBe("Nothing applied yet for alloplace. See what applying its file would change with lobbystack billing catalog-preview alloplace --billing-file @brands/alloplace/billing.json.");
  });

  it("shows how many live prices Polar sells, and the organization the catalog is linked to", async () => {
    const price = (period: string, polarId: string | null) => ({ period, currency: "cad", cents: 3000, polar_id: polarId, retired_at: null });
    const plans = [
      { code: "starter", tier: "starter", status: "active", access: "public", sold: true, prices: [price("monthly", "prod_1"), price("annual", "prod_2")] },
      { code: "pro", tier: "pro", status: "draft", access: "public", sold: true, prices: [price("monthly", null), price("annual", "prod_3")] },
      { code: "enterprise", tier: "enterprise", status: "active", access: "hidden", sold: false, prices: [] },
    ];
    const base = { brand: "alloplace", code_hash: hash, hash, matches_code: true, last_run: run, plans };
    const polar = { env: "sandbox", org: "org_test", secret_sha256: null, product_vars: {}, last_link: null };
    const api = fakeApi({
      "GET /api/v1/billing/catalog": [
        { body: { data: { ...base, polar: { ...polar, last_link: { ...run, kind: "polar", polar_env: "sandbox", polar_org: "org_test", started_at: "2026-10-21T09:00:00.000Z" } } } } },
        { body: { data: { ...base, polar } } },
        { body: { data: { ...base, polar: { ...polar, org: null } } } },
      ],
    });
    const linked = (await runCli(["billing", "catalog"], { fetch: api.fetch })).out;
    expect(linked).toMatch(/starter .*2 of 2 linked/);
    expect(linked).toMatch(/pro .*1 of 2 linked/);
    expect(linked).not.toMatch(/enterprise .*linked/);
    expect(linked.endsWith("Linked to Polar sandbox organization org_test 2026-10-21T09:00:00.000Z.")).toBe(true);
    expect((await runCli(["billing", "catalog"], { fetch: api.fetch })).out.endsWith("Polar sandbox organization org_test, not linked yet: run pnpm billing apply.")).toBe(true);
    expect((await runCli(["billing", "catalog"], { fetch: api.fetch })).out.endsWith("POLAR_ORGANIZATION_ID isn't set, so nothing links Polar's products yet.")).toBe(true);
  });

  it("names another provider's account, counts the prices it links, and says where a link went", async () => {
    const price = (period: string, ref: string | null) => ({ period, currency: "cad", cents: 3000, polar_id: null, provider_ref: ref, retired_at: null });
    const plans = [{ code: "starter", tier: "starter", status: "active", access: "public", sold: true, prices: [price("monthly", "price_1"), price("annual", null)] }];
    const base = { brand: "alloplace", code_hash: hash, hash, matches_code: true, last_run: run, plans, polar: null };
    const provider = { id: "stripe", env: "live", account: "acct_1", secret_sha256: null, objects: null, product_vars: null, last_link: null };
    const linkRun = { ...run, kind: "link", polar_env: null, polar_org: null, provider: "stripe", provider_env: "live", provider_account: "acct_1", started_at: "2026-11-08T09:00:00.000Z" };
    const api = fakeApi({
      "GET /api/v1/billing/catalog": [
        { body: { data: { ...base, provider: { ...provider, last_link: linkRun } } } },
        { body: { data: { ...base, provider } } },
      ],
      "POST /api/v1/billing/catalog/links": { status: 201, body: { data: { ...linkRun, status: "applied", changes: [] } } },
    });
    const linked = (await runCli(["billing", "catalog"], { fetch: api.fetch })).out;
    expect(linked).toMatch(/starter .*1 of 2 linked/);
    expect(linked.endsWith("Linked to Stripe live account acct_1 2026-11-08T09:00:00.000Z.")).toBe(true);
    expect((await runCli(["billing", "catalog"], { fetch: api.fetch })).out.endsWith("Stripe live account acct_1, not linked yet: run pnpm billing apply.")).toBe(true);
    const body = JSON.stringify({ hash, provider: "stripe", provider_env: "live", provider_account: "acct_1", plans: [] });
    expect((await runCli(["billing", "catalog-link", "alloplace", "--data", body, "--idempotency-key", "link-2"], { fetch: api.fetch })).out).toBe(`Linked Stripe live account acct_1 with 0 changes in run ${run.id}.`);
  });

  it("links Polar's products from a file, with an Idempotency-Key, and says what it changed or what stops it", async () => {
    const linkRun = { ...run, kind: "polar", polar_env: "sandbox", polar_org: "org_test", provider: "polar", provider_env: "sandbox", provider_account: "org_test" };
    const priceChange = { table: "billing_prices", key: "pro/monthly/cad", action: "update", fields: { polar_id: { from: null, to: "prod_1" } }, lowers_allowance: false, raises_price: false };
    const api = fakeApi({
      "POST /api/v1/billing/catalog/links": [
        { status: 201, body: { data: { ...linkRun, changes: [priceChange] } } },
        { body: { data: { ...linkRun, id: null, status: "preview", changes: [], blocked_by: [{ code: "polar_org_changed", message: "It stays with org_test.", path: "polar_org" }] } } },
        { status: 201, body: { data: { ...linkRun, status: "unchanged", changes: [] } } },
      ],
    });
    const plans = [{ code: "pro", terms_hash: "b".repeat(64), polar_disc: null, prices: [{ period: "monthly", currency: "cad", polar_id: "prod_1" }] }];
    const body = JSON.stringify({ hash, polar_env: "sandbox", polar_org: "org_test", plans });
    const linked = await runCli(["billing", "catalog-link", "alloplace", "--data", body, "--idempotency-key", "link-1"], { fetch: api.fetch });
    expect(linked.code).toBe(exitCodes.ok);
    expect(api.sent[0]).toMatchObject({ headers: { "idempotency-key": "link-1" }, body: { brand: "alloplace", hash, polar_env: "sandbox", polar_org: "org_test", plans } });
    expect(linked.out).toContain("polar_id");
    expect(linked.out).toContain(`Linked Polar sandbox organization org_test with 1 change in run ${run.id}.`);
    const refused = await runCli(["billing", "catalog-link", "alloplace", "--data", body, "--dry-run"], { fetch: api.fetch });
    expect(api.sent[1]!.body).toMatchObject({ dry_run: true });
    expect(refused.out).toBe("Linking would be refused, and nothing would change:\n  polar_org_changed (polar_org): It stays with org_test.");
    expect((await runCli(["billing", "catalog-link", "alloplace", "--data", body], { fetch: api.fetch })).out).toBe(`The tables already had these products in run ${run.id}.`);
  });

  it("lists runs of one kind", async () => {
    const api = fakeApi({ "GET /api/v1/billing/catalog/runs": { body: { data: [{ ...run, changes }], next_cursor: null, has_more: false } } });
    const result = await runCli(["billing", "catalog-runs", "--kind", "catalog"], { fetch: api.fetch });
    expect(api.sent[0]!.query).toEqual({ kind: "catalog" });
    expect(result.out).toContain(run.id);
  });
});

describe("billing promo codes", () => {
  const code = { id: "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5", code: "ALLO-7K2Q-PX9M", plan: "pro_launch", business_id: null, max_uses: 50, uses: 0, expires_at: "2026-12-31T00:00:00.000Z", status: "active", note: null, link: "https://app.example.com/signup?promo=ALLO-7K2Q-PX9M", key_id: "1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7a8b", partner: "operator", created_at: "2026-10-22T09:00:00.000Z", revoked_at: null };

  it("issues a code with an Idempotency-Key and prints the link to send", async () => {
    const api = fakeApi({ "POST /api/v1/billing/codes": { status: 201, body: { data: code } } });
    const result = await runCli(["billing", "code-create", "pro_launch", "--max-uses", "50", "--expires-at", "2026-12-31T00:00:00Z"], { fetch: api.fetch });
    expect(result.code).toBe(exitCodes.ok);
    expect(api.sent[0]!.body).toEqual({ plan: "pro_launch", max_uses: 50, expires_at: "2026-12-31T00:00:00Z" });
    expect(api.sent[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.out.endsWith(`Send this link, or the code ALLO-7K2Q-PX9M for Settings > Plan: ${code.link}`)).toBe(true);
  });

  it("lists codes of one plan and revokes one", async () => {
    const api = fakeApi({
      "GET /api/v1/billing/codes": { body: { data: [code], next_cursor: null, has_more: false } },
      [`DELETE /api/v1/billing/codes/${code.id}`]: { body: { data: { ...code, status: "revoked", revoked_at: "2026-10-22T10:00:00.000Z" } } },
    });
    const listed = await runCli(["billing", "codes", "--plan", "pro_launch"], { fetch: api.fetch });
    expect(api.sent[0]!.query).toEqual({ plan: "pro_launch" });
    expect(listed.out).toMatch(/ALLO-7K2Q-PX9M\s+pro_launch/);
    const revoked = await runCli(["billing", "code-revoke", code.id], { fetch: api.fetch });
    expect(revoked.code).toBe(exitCodes.ok);
    expect(revoked.out).toContain("revoked");
  });
});
