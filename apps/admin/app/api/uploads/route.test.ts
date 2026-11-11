import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ finalize: vi.fn() }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  requireApiSession: async () => ({ user: { id: "user_1" } }),
}));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: "app" }) }));
vi.mock("@/lib/storage", () => ({ getStorageProvider: () => ({ name: "storage" }) }));
vi.mock("@lobbystack/domain", async (original) => ({
  ...await original<typeof import("@lobbystack/domain")>(),
  finalizeUpload: fixture.finalize,
}));

import { PUT } from "./route";

const BUSINESS = "00000000-0000-4000-8000-0000000000a1";
const OBJECT = "00000000-0000-4000-8000-0000000000c1";
const GASTOWN = "00000000-0000-4000-8000-0000000000b2";
const upload = { businessId: BUSINESS, objectId: OBJECT, length: 2048, contentType: "application/pdf", checksum: "c3Vt", title: "Gastown menu" };
const finalize = (body: unknown) => PUT(new Request("http://localhost:3000/api/uploads", { method: "PUT", body: JSON.stringify(body) }));

beforeEach(() => { vi.clearAllMocks(); });

describe("finishing a knowledge upload", () => {
  it("adds the file for everyone unless the body chooses receptionists", async () => {
    expect((await finalize(upload)).status).toBe(200);
    expect(fixture.finalize).toHaveBeenCalledWith({ db: "app" }, { ...upload, userId: "user_1" }, { name: "storage" });
  });

  it("adds the file for the receptionists chosen, in the same save", async () => {
    expect((await finalize({ ...upload, audience: "chosen", receptionistIds: [GASTOWN] })).status).toBe(200);
    expect(fixture.finalize).toHaveBeenCalledWith({ db: "app" }, { ...upload, userId: "user_1", audience: { audience: "chosen", receptionistIds: [GASTOWN] } }, { name: "storage" });
  });

  it("refuses an audience it can't use before finishing the upload", async () => {
    const response = await finalize({ ...upload, audience: "chosen", receptionistIds: [] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_audience" });
    expect(fixture.finalize).not.toHaveBeenCalled();
  });
});
