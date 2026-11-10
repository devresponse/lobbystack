import { beforeEach, describe, expect, it, vi } from "vitest";

// What the route reads and hands to the domain; the queries are covered by
// entryLinks.integration.test.ts.
const fixture = vi.hoisted(() => ({ denied: false, options: vi.fn(), list: vi.fn(), create: vi.fn() }));
const tx = vi.hoisted(() => ({ name: "tx" }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  withOperatorTransaction: async (_request: Request, callback: (input: unknown) => unknown, options: unknown) => {
    fixture.options(options);
    if (fixture.denied) throw Object.assign(new Error("Forbidden"), { status: 403 });
    return await callback({ session: { user: { id: "owner" } }, businessId: "business", tx });
  },
}));
vi.mock("@lobbystack/domain", async (original) => ({
  ...await original<typeof import("@lobbystack/domain")>(),
  listEntryLinksInTransaction: fixture.list,
  createEntryLinkInTransaction: fixture.create,
}));
import { GET, POST } from "./route";

const GASTOWN = "00000000-0000-4000-8000-0000000000b2";
const link = { id: "00000000-0000-4000-8000-0000000000c1", code: "a9fp8b", label: "Window sign", status: "active", receptionistId: GASTOWN, opensReceptionistId: GASTOWN, scansLast30Days: 0, scansKept: 0, lastScannedOn: null };
const list = (query = "") => GET(new Request(`http://localhost:3000/api/entry-links${query}`));
const add = (body: unknown) => POST(new Request("http://localhost:3000/api/entry-links", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.denied = false;
  fixture.list.mockResolvedValue({ links: [link], total: 1, page: 1, pageSize: 10 });
  fixture.create.mockResolvedValue(link);
});

describe("the QR links list", () => {
  it("gives the first page to anyone on the team", async () => {
    const response = await list();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ links: [link], total: 1, page: 1, pageSize: 10 });
    expect(fixture.list).toHaveBeenCalledWith(tx, { businessId: "business", receptionistId: undefined, status: undefined, search: undefined, page: 1 });
    expect(fixture.options).toHaveBeenCalledWith(undefined);
  });

  it("keeps one receptionist's links, by status and a search, a page at a time", async () => {
    await list(`?receptionist=${GASTOWN.toUpperCase()}&status=paused&search=%20window%20&page=2`);
    expect(fixture.list).toHaveBeenCalledWith(tx, { businessId: "business", receptionistId: GASTOWN, status: "paused", search: "window", page: 2 });
  });

  it("refuses a receptionist or status that can't be one, before reading anything", async () => {
    expect(await (await list("?receptionist=gastown")).json()).toEqual({ error: "receptionist must be a receptionist id.", code: "invalid_receptionist" });
    expect(await (await list("?status=deleted")).json()).toEqual({ error: "status must be active or paused.", code: "invalid_status" });
    expect(fixture.options).not.toHaveBeenCalled();
  });
});

describe("adding a QR link", () => {
  it("adds one for an owner or admin, labelled with where its sign hangs", async () => {
    const response = await add({ receptionistId: GASTOWN, label: "  Window   sign " });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ link });
    expect(fixture.create).toHaveBeenCalledWith(tx, { businessId: "business", actorUserId: "owner", link: { receptionistId: GASTOWN, label: "Window sign" } });
    expect(fixture.options).toHaveBeenCalledWith({ minimumRole: "business_admin" });
  });

  it.each([null, [], {}, { receptionistId: "gastown" }, { receptionistId: GASTOWN, label: 5 }, { receptionistId: GASTOWN, label: "x".repeat(81) }])("refuses %j before opening a transaction", async (body) => {
    expect((await add(body)).status).toBe(400);
    expect(fixture.options).not.toHaveBeenCalled();
  });

  it("says when the business keeps the most links it may", async () => {
    fixture.create.mockRejectedValue(Object.assign(new Error("A business can keep up to 500 QR links. Change a paused one instead."), { status: 409, code: "entry_link_limit" }));
    const response = await add({ receptionistId: GASTOWN });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "entry_link_limit" });
  });

  it("leaves viewers and schedulers out", async () => {
    fixture.denied = true;
    expect((await add({ receptionistId: GASTOWN })).status).toBe(403);
    expect(fixture.create).not.toHaveBeenCalled();
  });
});
