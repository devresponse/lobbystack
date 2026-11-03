import { beforeEach, describe, expect, it, vi } from "vitest";

// The saving itself, with the snapshot refresh and the summary job it queues,
// is the domain's (receptionistProfile.test.ts and the receptionist
// integration tests); this checks what the route reads and hands over.
const fixture = vi.hoisted(() => ({
  denied: false,
  business: [{ name: "Clinic" }] as Array<{ name: string }>,
  transaction: vi.fn(),
  save: vi.fn(),
  updateBusiness: vi.fn(),
  loadView: vi.fn(),
  choices: vi.fn(),
}));
const tx = vi.hoisted(() => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => fixture.business }) }) }) }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  withOperatorTransaction: async (_request: Request, callback: (input: unknown) => unknown, options: unknown) => {
    fixture.transaction(options);
    if (fixture.denied) throw Object.assign(new Error("Forbidden"), { status: 403 });
    return callback({ businessId: "business", tx });
  },
}));
vi.mock("@lobbystack/domain", async (original) => ({
  ...await original<typeof import("@lobbystack/domain")>(),
  saveReceptionistProfileInTransaction: fixture.save,
  updateBusinessInTransaction: fixture.updateBusiness,
  loadReceptionistView: fixture.loadView,
  listReceptionistChoicesInTransaction: fixture.choices,
}));
import { GET, PATCH } from "./route";

const kitsilanoId = "00000000-0000-4000-8000-0000000000a2";
const patch = (body: unknown, query = "") => PATCH(new Request(`http://localhost:3000/api/agent${query}`, { method: "PATCH", body: JSON.stringify(body) }));
const saved = () => fixture.save.mock.lastCall?.[1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  fixture.denied = false;
  fixture.business = [{ name: "Clinic" }];
  fixture.save.mockResolvedValue({ id: "profile", isDefault: true });
  fixture.loadView.mockResolvedValue({ id: "profile", isDefault: true, name: "Front desk" });
  fixture.choices.mockResolvedValue([{ id: "profile", name: "Front desk", isDefault: true }]);
});

describe("agent settings validation", () => {
  it.each([{}, [], null, { locale: "xx" }, { timezone: 5 }, { greeting: "" }, { transferMode: "invalid" }, { appointmentChangePolicy: {} }])("rejects invalid input %j before writing", async (body) => {
    expect((await patch(body)).status).toBe(400);
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.updateBusiness).not.toHaveBeenCalled();
  });

  it("names the field that is wrong, with the same message as before the rules moved to the domain", async () => {
    expect(await (await patch({ greeting: "" })).json()).toEqual({ error: "greeting is invalid." });
    expect(await (await patch({ bookingMode: "later" })).json()).toEqual({ error: "bookingMode is invalid." });
    expect(await (await patch({})).json()).toEqual({ error: "At least one profile field is required." });
  });

  it("saves the language and timezone on the business, and the rest as the default receptionist's", async () => {
    const response = await patch({ locale: "fr", timezone: "Europe/Belgrade", greeting: "Bonjour, la clinique." });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ profile: { id: "profile", isDefault: true } });
    expect(fixture.updateBusiness).toHaveBeenCalledWith(tx, { businessId: "business", defaultLocale: "fr", timezone: "Europe/Belgrade" });
    expect(saved()).toEqual({ businessId: "business", businessName: "Clinic", receptionistId: null, patch: { greeting: "Bonjour, la clinique." }, regenerateSummary: false });
  });

  it("saves nothing when the business refuses the timezone", async () => {
    fixture.updateBusiness.mockRejectedValueOnce(Object.assign(new Error("timezone is invalid."), { status: 400 }));
    expect((await patch({ timezone: "Eastern", greeting: "Hello." })).status).toBe(400);
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it("leaves the business alone when only receptionist settings change", async () => {
    expect((await patch({ transferMode: "always" })).status).toBe(200);
    expect(fixture.updateBusiness).not.toHaveBeenCalled();
    expect(saved()).toMatchObject({ patch: { transferMode: "always" } });
  });

  it("saves another receptionist's own settings when the address names it", async () => {
    expect((await patch({ greeting: "Kitsilano store, hello!" }, `?receptionist=${kitsilanoId.toUpperCase()}`)).status).toBe(200);
    expect(saved()).toMatchObject({ receptionistId: kitsilanoId, patch: { greeting: "Kitsilano store, hello!" } });
    const refused = await patch({ greeting: "Hello!" }, "?receptionist=kitsilano");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "invalid_receptionist" });
  });

  it("keeps only the typed appointment policy", async () => {
    const policy = { enabled: true, allowCancel: false, allowReschedule: true, verificationMode: "otp_required" };
    expect((await patch({ appointmentChangePolicy: { ...policy, arbitrary: "discard" } })).status).toBe(200);
    expect(saved()).toMatchObject({ patch: { appointmentChangePolicy: policy } });
  });

  it("passes a summary someone wrote, or the request to hand it back to AI", async () => {
    expect((await patch({ summary: "Maple Family Clinic offers checkups in Toronto." })).status).toBe(200);
    expect(saved()).toMatchObject({ patch: { summary: "Maple Family Clinic offers checkups in Toronto." }, regenerateSummary: false });
    expect((await patch({ regenerateSummary: true })).status).toBe(200);
    expect(saved()).toMatchObject({ patch: {}, regenerateSummary: true });
  });

  it.each([{ regenerateSummary: false }, { regenerateSummary: true, summary: "Written by hand." }])("rejects an unclear summary request %j", async (body) => {
    expect((await patch(body)).status).toBe(400);
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it("answers 404 for a business it can't find and 500 when nothing was saved", async () => {
    fixture.business = [];
    expect((await patch({ greeting: "Hello." })).status).toBe(404);
    expect(fixture.save).not.toHaveBeenCalled();
    fixture.business = [{ name: "Clinic" }];
    fixture.save.mockResolvedValueOnce(null);
    expect((await patch({ greeting: "Hello." })).status).toBe(500);
  });

  it("requires administrator access before any mutation", async () => {
    fixture.denied = true;
    expect((await patch({ transferMode: "always" })).status).toBe(403);
    expect(fixture.transaction).toHaveBeenCalledWith({ minimumRole: "business_admin" });
    expect(fixture.save).not.toHaveBeenCalled();
  });
});

describe("reading the AI settings", () => {
  const get = (query = "") => GET(new Request(`http://localhost:3000/api/agent${query}`));

  it("returns the default receptionist's settings and the receptionists to pick from", async () => {
    const response = await get();
    expect(await response.json()).toEqual({ business: { name: "Clinic" }, profile: { id: "profile", isDefault: true, name: "Front desk" }, receptionists: [{ id: "profile", name: "Front desk", isDefault: true }] });
    expect(fixture.loadView).toHaveBeenCalledWith(tx, { businessId: "business", receptionistId: null });
  });

  it("returns the receptionist the address names, and 404 for one the business doesn't have", async () => {
    await get(`?receptionist=${kitsilanoId}`);
    expect(fixture.loadView).toHaveBeenCalledWith(tx, { businessId: "business", receptionistId: kitsilanoId });
    fixture.loadView.mockResolvedValueOnce(null);
    expect((await get(`?receptionist=${kitsilanoId}`)).status).toBe(404);
  });
});
