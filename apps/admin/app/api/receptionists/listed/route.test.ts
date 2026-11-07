import { beforeEach, describe, expect, it, vi } from "vitest";

import { receptionistChoice } from "@/lib/receptionist-testing";

type Domain = typeof import("@lobbystack/domain");
const fixture = vi.hoisted(() => ({ options: vi.fn(), setListed: vi.fn<Domain["setListedReceptionistsInTransaction"]>(), choices: vi.fn<Domain["listReceptionistChoicesInTransaction"]>() }));
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
  setListedReceptionistsInTransaction: fixture.setListed,
  listReceptionistChoicesInTransaction: fixture.choices,
}));
import { PUT } from "./route";

const SALES = "00000000-0000-4000-8000-0000000000b1";
const SUPPORT = "00000000-0000-4000-8000-0000000000b2";
const listed = (body: unknown) => PUT(new Request("http://localhost:3000/api/receptionists/listed", { method: "PUT", body: JSON.stringify(body) }));
const choices = [receptionistChoice({ id: SALES, name: "Sales", listed: true }), receptionistChoice({ id: SUPPORT, name: "Support", listed: true, sortOrder: 1 })];

beforeEach(() => {
  vi.clearAllMocks();
  fixture.choices.mockResolvedValue(choices);
});

describe("the receptionists the business page lists", () => {
  it("saves them in one step for an owner or admin and gives the pickers' list back", async () => {
    const response = await listed({ receptionistIds: [SALES, SUPPORT.toUpperCase()] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receptionists: choices });
    expect(fixture.setListed).toHaveBeenCalledWith(tx, { businessId: "business", actorUserId: "owner", receptionistIds: [SALES, SUPPORT] });
    expect(fixture.options).toHaveBeenCalledWith({ minimumRole: "business_admin" });
  });

  it("takes none, so the page offers only the default", async () => {
    expect((await listed({ receptionistIds: [] })).status).toBe(200);
    expect(fixture.setListed).toHaveBeenCalledWith(tx, { businessId: "business", actorUserId: "owner", receptionistIds: [] });
  });

  it.each([null, [SALES], {}, { receptionistIds: "sales" }, { receptionistIds: ["sales"] }, { receptionistIds: [SALES, SALES] }])("refuses %j before opening a transaction", async (body) => {
    const response = await listed(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_listed" });
    expect(fixture.options).not.toHaveBeenCalled();
  });

  it("passes on the domain's refusal of a receptionist that was archived", async () => {
    fixture.setListed.mockRejectedValue(Object.assign(new Error("Receptionist not found."), { status: 404, code: "receptionist_not_found" }));
    const response = await listed({ receptionistIds: [SALES] });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "receptionist_not_found" });
  });
});
