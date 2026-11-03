import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ options: vi.fn(), get: vi.fn(), scans: vi.fn(), update: vi.fn() }));
const tx = vi.hoisted(() => ({ name: "tx" }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  withOperatorTransaction: async (_request: Request, callback: (input: unknown) => unknown, options: unknown) => {
    fixture.options(options);
    return await callback({ session: { user: { id: "owner" } }, businessId: "business", tx });
  },
}));
vi.mock("@lobbystack/domain", async (original) => ({
  ...await original<typeof import("@lobbystack/domain")>(),
  getEntryLinkInTransaction: fixture.get,
  listEntryLinkScansInTransaction: fixture.scans,
  updateEntryLinkInTransaction: fixture.update,
}));
import { GET, PATCH } from "./route";

const LINK = "00000000-0000-4000-8000-0000000000c1";
const KITSILANO = "00000000-0000-4000-8000-0000000000a2";
const link = { id: LINK, code: "a9fp8b", label: "Window sign", status: "active", receptionistId: KITSILANO, opensReceptionistId: KITSILANO };
const params = (linkId = LINK) => ({ params: Promise.resolve({ linkId }) });
const read = (linkId = LINK) => GET(new Request(`http://localhost:3000/api/entry-links/${linkId}`), params(linkId));
const change = (body: unknown) => PATCH(new Request(`http://localhost:3000/api/entry-links/${LINK}`, { method: "PATCH", body: JSON.stringify(body) }), params());

beforeEach(() => {
  vi.clearAllMocks();
  fixture.get.mockResolvedValue(link);
  fixture.scans.mockResolvedValue([{ day: "2026-11-01", scans: 4 }, { day: "2026-11-02", scans: 9 }]);
  fixture.update.mockResolvedValue({ ...link, status: "paused" });
});

describe("one QR link", () => {
  it("gives the link with its scans per day for the chart, to anyone on the team", async () => {
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ link, scans: [{ day: "2026-11-01", scans: 4 }, { day: "2026-11-02", scans: 9 }] });
    expect(fixture.get).toHaveBeenCalledWith(tx, { businessId: "business", linkId: LINK });
    expect(fixture.scans).toHaveBeenCalledWith(tx, { businessId: "business", linkId: LINK });
    expect(fixture.options).toHaveBeenCalledWith(undefined);
  });

  it("isn't found when the business has no such link", async () => {
    fixture.get.mockResolvedValue(null);
    const response = await read("another-business-link");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "QR link not found.", code: "entry_link_not_found" });
    expect(fixture.scans).not.toHaveBeenCalled();
  });
});

describe("changing a QR link", () => {
  it("pauses it, points it at another receptionist or relabels it, for an owner or admin", async () => {
    const response = await change({ status: "paused", receptionistId: KITSILANO, label: "Counter" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ link: { ...link, status: "paused" } });
    expect(fixture.update).toHaveBeenCalledWith(tx, { businessId: "business", actorUserId: "owner", linkId: LINK, patch: { receptionistId: KITSILANO, label: "Counter", status: "paused" } });
    expect(fixture.options).toHaveBeenCalledWith({ minimumRole: "business_admin" });
  });

  it.each([null, {}, { status: "deleted" }, { receptionistId: "kitsilano" }, { code: "newcode" }])("refuses %j before opening a transaction", async (body) => {
    expect((await change(body)).status).toBe(400);
    expect(fixture.options).not.toHaveBeenCalled();
  });

  it("passes on the domain's 404 for a link or receptionist the business doesn't have", async () => {
    fixture.update.mockRejectedValue(Object.assign(new Error("The receptionist was not found, or is archived."), { status: 404, code: "receptionist_not_found" }));
    expect((await change({ receptionistId: KITSILANO })).status).toBe(404);
  });
});
