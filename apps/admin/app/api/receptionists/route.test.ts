import { beforeEach, describe, expect, it, vi } from "vitest";

// What the route reads from the request and hands to the domain; the queries
// themselves are covered by receptionists.integration.test.ts.
const fixture = vi.hoisted(() => ({
  denied: false,
  options: vi.fn(),
  list: vi.fn(),
  allowance: vi.fn(),
  create: vi.fn(),
}));
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
  listReceptionistsInTransaction: fixture.list,
  receptionistAllowanceInTransaction: fixture.allowance,
  createReceptionistInTransaction: fixture.create,
}));
import { GET, POST } from "./route";

const GASTOWN = "00000000-0000-4000-8000-0000000000b2";
const allowance = { plan: "pro", limit: 5, used: 2, remaining: 3 };
const page = { receptionists: [{ id: "front-desk", name: "Front desk" }], total: 1, page: 1, pageSize: 10 };
const list = (query = "") => GET(new Request(`http://localhost:3000/api/receptionists${query}`));
const add = (body: unknown) => POST(new Request("http://localhost:3000/api/receptionists", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.denied = false;
  fixture.list.mockResolvedValue(page);
  fixture.allowance.mockResolvedValue(allowance);
  fixture.create.mockImplementation(async (_tx, input: { receptionist: { name: string } }) => ({ id: GASTOWN, name: input.receptionist.name }));
});

describe("the Receptionists page's list", () => {
  it("gives the first page of current receptionists with the plan's allowance, to anyone on the team", async () => {
    const response = await list();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...page, allowance });
    expect(fixture.list).toHaveBeenCalledWith(tx, { businessId: "business", view: "current", status: undefined, search: undefined, page: 1, pageSize: 10 });
    expect(fixture.allowance).toHaveBeenCalledWith(tx, { businessId: "business" });
    expect(fixture.options).toHaveBeenCalledWith(undefined);
  });

  it("passes the archived view, a status, a trimmed search and the page asked for", async () => {
    await list("?view=archived&status=paused&search=%20%20gastown%20&page=3&pageSize=20");
    expect(fixture.list).toHaveBeenCalledWith(tx, { businessId: "business", view: "archived", status: "paused", search: "gastown", page: 3, pageSize: 20 });
  });

  it("reads anything else as the first page of 10 current receptionists, without a search", async () => {
    for (const query of ["?view=everything&page=0", "?page=two&pageSize=0", "?page=1.5&search=%20&pageSize=51", "?page=10001&pageSize=ten"]) {
      await list(query);
      expect(fixture.list).toHaveBeenLastCalledWith(tx, { businessId: "business", view: "current", status: undefined, search: undefined, page: 1, pageSize: 10 });
    }
  });

  it("refuses a status that isn't one, before reading anything", async () => {
    const response = await list("?status=archived");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "status must be active or paused.", code: "invalid_status" });
    expect(fixture.list).not.toHaveBeenCalled();
  });
});

describe("adding a receptionist", () => {
  it("adds it for an owner or admin, copying another's settings when asked", async () => {
    const response = await add({ name: "  Gastown store ", description: "Our store on Water Street", handle: "gastown", copyFromId: "00000000-0000-4000-8000-0000000000A1" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ receptionist: { id: GASTOWN, name: "Gastown store" } });
    expect(fixture.options).toHaveBeenCalledWith({ minimumRole: "business_admin" });
    expect(fixture.create).toHaveBeenCalledWith(tx, {
      businessId: "business",
      actorUserId: "owner",
      receptionist: { name: "Gastown store", description: "Our store on Water Street", handle: "gastown", copyFromId: "00000000-0000-4000-8000-0000000000a1" },
    });
  });

  it.each([null, [], {}, { name: "" }, { name: "Gastown", handle: "two words" }, { name: "Gastown", copyFromId: "front-desk" }, { name: "Gastown", listed: "yes" }])("refuses %j before opening a transaction", async (body) => {
    expect((await add(body)).status).toBe(400);
    expect(fixture.options).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("says why when the plan has no room left", async () => {
    const message = "Your plan includes 5 active receptionists. Pause one or upgrade to add another.";
    fixture.create.mockRejectedValue(Object.assign(new Error(message), { status: 409, code: "receptionist_limit" }));
    const response = await add({ name: "Yaletown store" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: message, code: "receptionist_limit" });
  });

  it("leaves viewers and schedulers out", async () => {
    fixture.denied = true;
    expect((await add({ name: "Yaletown store" })).status).toBe(403);
    expect(fixture.create).not.toHaveBeenCalled();
  });
});
