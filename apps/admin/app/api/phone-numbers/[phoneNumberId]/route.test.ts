import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ denied: false, options: vi.fn(), set: vi.fn() }));
const tx = vi.hoisted(() => ({ name: "tx" }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  withOperatorTransaction: async (_request: Request, callback: (input: unknown) => unknown, options: unknown) => {
    fixture.options(options);
    if (fixture.denied) throw Object.assign(new Error("Forbidden"), { status: 403 });
    return await callback({ session: { user: { id: "owner" } }, businessId: "business", tx });
  },
}));
vi.mock("@lobbystack/domain", async (original) => ({ ...await original<typeof import("@lobbystack/domain")>(), setPhoneNumberReceptionistInTransaction: fixture.set }));
import { PATCH } from "./route";

const NUMBER = "00000000-0000-4000-8000-000000000041";
const GASTOWN = "00000000-0000-4000-8000-0000000000b2";
const choose = (body: unknown) => PATCH(new Request(`http://localhost:3000/api/phone-numbers/${NUMBER}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ phoneNumberId: NUMBER }) });

beforeEach(() => {
  vi.clearAllMocks();
  fixture.denied = false;
  fixture.set.mockResolvedValue({ id: NUMBER, e164: "+16045550188", receptionistId: GASTOWN });
});

it("chooses who answers the number, for an owner or admin", async () => {
  const response = await choose({ receptionistId: GASTOWN.toUpperCase() });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ phoneNumber: { id: NUMBER, e164: "+16045550188", receptionistId: GASTOWN } });
  expect(fixture.set).toHaveBeenCalledWith(tx, { businessId: "business", actorUserId: "owner", phoneNumberId: NUMBER, receptionistId: GASTOWN });
  expect(fixture.options).toHaveBeenCalledWith({ minimumRole: "business_admin" });
});

it.each([null, [], {}, { receptionistId: "gastown" }, { receptionistId: null }])("refuses %j before opening a transaction", async (body) => {
  expect((await choose(body)).status).toBe(400);
  expect(fixture.options).not.toHaveBeenCalled();
});

it("says when the receptionist is archived", async () => {
  fixture.set.mockRejectedValue(Object.assign(new Error("An archived receptionist can't answer. Restore it first."), { status: 409, code: "receptionist_archived" }));
  const response = await choose({ receptionistId: GASTOWN });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "An archived receptionist can't answer. Restore it first.", code: "receptionist_archived" });
});

it("leaves viewers and schedulers out", async () => {
  fixture.denied = true;
  expect((await choose({ receptionistId: GASTOWN })).status).toBe(403);
  expect(fixture.set).not.toHaveBeenCalled();
});
