import { beforeEach, describe, expect, it, vi } from "vitest";

import { asJson, receptionistView } from "@/lib/receptionist-testing";

type Domain = typeof import("@lobbystack/domain");
const fixture = vi.hoisted(() => ({
  options: vi.fn(),
  update: vi.fn<Domain["updateReceptionistInTransaction"]>(),
  setStatus: vi.fn<Domain["setReceptionistStatusInTransaction"]>(),
  archive: vi.fn<Domain["archiveReceptionistInTransaction"]>(),
  restore: vi.fn<Domain["restoreReceptionistInTransaction"]>(),
  makeDefault: vi.fn<Domain["makeDefaultReceptionistInTransaction"]>(),
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
  updateReceptionistInTransaction: fixture.update,
  setReceptionistStatusInTransaction: fixture.setStatus,
  archiveReceptionistInTransaction: fixture.archive,
  restoreReceptionistInTransaction: fixture.restore,
  makeDefaultReceptionistInTransaction: fixture.makeDefault,
}));
import { PATCH, POST } from "./route";

const GASTOWN = "00000000-0000-4000-8000-0000000000b2";
const params = { params: Promise.resolve({ receptionistId: GASTOWN }) };
const send = (method: "PATCH" | "POST", body: unknown) => (method === "PATCH" ? PATCH : POST)(new Request(`http://localhost:3000/api/receptionists/${GASTOWN}`, { method, body: JSON.stringify(body) }), params);
const actor = { businessId: "business", actorUserId: "owner", receptionistId: GASTOWN };
const gastown = receptionistView({ id: GASTOWN, name: "Gastown store", handle: "gastown" });

beforeEach(() => {
  vi.clearAllMocks();
  fixture.update.mockResolvedValue(gastown);
  fixture.setStatus.mockResolvedValue(gastown);
  fixture.restore.mockResolvedValue(gastown);
  fixture.makeDefault.mockResolvedValue({ ...gastown, isDefault: true });
});

describe("changing a receptionist", () => {
  it("saves its name, page address, language, knowledge and listing for an owner or admin", async () => {
    const response = await send("PATCH", { name: "Gastown store", handle: "gastown", locale: null, knowledgeScope: "audience", listed: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receptionist: asJson(gastown) });
    expect(fixture.update).toHaveBeenCalledWith(tx, { ...actor, patch: { name: "Gastown store", handle: "gastown", locale: null, knowledgeScope: "audience", listed: false } });
    expect(fixture.options).toHaveBeenCalledWith({ minimumRole: "business_admin" });
  });

  it.each([null, {}, { name: "" }, { handle: "two words" }, { knowledgeScope: "some" }, { status: "paused" }])("refuses %j before opening a transaction", async (body) => {
    expect((await send("PATCH", body)).status).toBe(400);
    expect(fixture.options).not.toHaveBeenCalled();
  });

  it("says when another receptionist has the page address", async () => {
    fixture.update.mockRejectedValue(Object.assign(new Error("Another receptionist already uses this page address."), { status: 409, code: "handle_taken" }));
    expect(await (await send("PATCH", { handle: "kitsilano" })).json()).toEqual({ error: "Another receptionist already uses this page address.", code: "handle_taken" });
  });
});

describe("a receptionist's actions", () => {
  it("pauses and resumes it", async () => {
    expect((await send("POST", { action: "pause" })).status).toBe(200);
    expect(fixture.setStatus).toHaveBeenLastCalledWith(tx, { ...actor, status: "paused" });
    expect((await send("POST", { action: "resume" })).status).toBe(200);
    expect(fixture.setStatus).toHaveBeenLastCalledWith(tx, { ...actor, status: "active" });
  });

  it("archives it, leaving nothing to show, and restores it", async () => {
    const archived = await send("POST", { action: "archive" });
    expect(await archived.json()).toEqual({ receptionist: null });
    expect(fixture.archive).toHaveBeenCalledWith(tx, actor);
    expect(await (await send("POST", { action: "restore" })).json()).toEqual({ receptionist: asJson(gastown) });
    expect(fixture.restore).toHaveBeenCalledWith(tx, actor);
  });

  it("makes it the default receptionist", async () => {
    const response = await send("POST", { action: "make_default" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ receptionist: { id: GASTOWN, isDefault: true } });
    expect(fixture.makeDefault).toHaveBeenCalledWith(tx, actor);
    expect(fixture.options).toHaveBeenCalledWith({ minimumRole: "business_admin" });
  });

  it.each([null, {}, { action: "delete" }, { action: "PAUSE" }])("refuses %j before opening a transaction", async (body) => {
    const response = await send("POST", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_action" });
    expect(fixture.options).not.toHaveBeenCalled();
  });

  it("passes on why the domain refused, such as archiving the default receptionist", async () => {
    fixture.archive.mockRejectedValue(Object.assign(new Error("The default receptionist can't be archived. Make another one the default first."), { status: 409, code: "default_receptionist" }));
    const response = await send("POST", { action: "archive" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "The default receptionist can't be archived. Make another one the default first.", code: "default_receptionist" });
  });
});
