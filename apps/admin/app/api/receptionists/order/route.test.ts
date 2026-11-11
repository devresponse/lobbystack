import { beforeEach, describe, expect, it, vi } from "vitest";

import { receptionistChoice } from "@/lib/receptionist-testing";

type Domain = typeof import("@lobbystack/domain");
const fixture = vi.hoisted(() => ({
  options: vi.fn(),
  reorder: vi.fn<Domain["reorderReceptionistsInTransaction"]>(),
  sortByName: vi.fn<Domain["sortReceptionistsByNameInTransaction"]>(),
  choices: vi.fn<Domain["listReceptionistChoicesInTransaction"]>(),
}));
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
  reorderReceptionistsInTransaction: fixture.reorder,
  sortReceptionistsByNameInTransaction: fixture.sortByName,
  listReceptionistChoicesInTransaction: fixture.choices,
}));
import { PUT } from "./route";

const FRONT_DESK = "00000000-0000-4000-8000-0000000000a1";
const GASTOWN = "00000000-0000-4000-8000-0000000000b2";
const order = (body: unknown) => PUT(new Request("http://localhost:3000/api/receptionists/order", { method: "PUT", body: JSON.stringify(body) }));
const choices = [receptionistChoice({ id: FRONT_DESK, name: "Front desk", isDefault: true }), receptionistChoice({ id: GASTOWN, name: "Gastown store", sortOrder: 1 })];

beforeEach(() => {
  vi.clearAllMocks();
  fixture.choices.mockResolvedValue(choices);
});

describe("the receptionists' order", () => {
  it("saves it for an owner or admin and gives the pickers' list back", async () => {
    const response = await order({ receptionistIds: [GASTOWN, FRONT_DESK.toUpperCase()] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receptionists: choices });
    expect(fixture.reorder).toHaveBeenCalledWith(tx, { businessId: "business", receptionistIds: [GASTOWN, FRONT_DESK] });
    expect(fixture.options).toHaveBeenCalledWith({ minimumRole: "business_admin" });
  });

  it("lists them by name from now on, for Sort A–Z and Alphabetical", async () => {
    const response = await order({ order: "alphabetical" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receptionists: choices });
    expect(fixture.sortByName).toHaveBeenCalledWith(tx, { businessId: "business" });
    expect(fixture.reorder).not.toHaveBeenCalled();
    expect(fixture.options).toHaveBeenCalledWith({ minimumRole: "business_admin" });
  });

  it.each([null, [GASTOWN], {}, { receptionistIds: [] }, { receptionistIds: ["gastown"] }, { receptionistIds: [GASTOWN, GASTOWN] }, { order: "custom" }, { order: "alphabetical", receptionistIds: [GASTOWN, FRONT_DESK] }])("refuses %j before opening a transaction", async (body) => {
    const response = await order(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_order" });
    expect(fixture.options).not.toHaveBeenCalled();
  });

  it("passes on the domain's refusal of an order that leaves a receptionist out", async () => {
    fixture.reorder.mockRejectedValue(Object.assign(new Error("List every receptionist that isn't archived, once each."), { status: 400, code: "invalid_order" }));
    expect((await order({ receptionistIds: [GASTOWN] })).status).toBe(400);
  });
});
