import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  requireApiSession: async () => ({ user: { id: "user_1" } }),
}));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: "app" }) }));
vi.mock("@lobbystack/domain", async (original) => ({
  ...await original<typeof import("@lobbystack/domain")>(),
  createKnowledgeSnippet: fixture.create,
}));

import { POST } from "./route";

const GASTOWN = "00000000-0000-4000-8000-0000000000b2";
const KITSILANO = "00000000-0000-4000-8000-0000000000b3";
const create = (body: unknown) => POST(new Request("http://localhost:3000/api/knowledge/snippets?businessId=business_1", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.create.mockResolvedValue("snippet_1");
});

describe("adding a text entry", () => {
  it("is for everyone unless the body chooses receptionists", async () => {
    const response = await create({ title: "Holiday hours", content: "Closed on December 25." });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ snippetId: "snippet_1" });
    expect(fixture.create).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", title: "Holiday hours", content: "Closed on December 25." });
  });

  it("is for the receptionists chosen, in the same save", async () => {
    expect((await create({ title: "Gastown parking", content: "Park on Water Street.", tags: ["parking"], audience: "chosen", receptionistIds: [GASTOWN, KITSILANO] })).status).toBe(201);
    expect(fixture.create).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", title: "Gastown parking", content: "Park on Water Street.", tags: ["parking"], audience: { audience: "chosen", receptionistIds: [GASTOWN, KITSILANO] } });
    expect((await create({ title: "Holiday hours", content: "Closed.", audience: "everyone", receptionistIds: [GASTOWN] })).status).toBe(201);
    expect(fixture.create).toHaveBeenLastCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", title: "Holiday hours", content: "Closed.", audience: { audience: "everyone" } });
  });

  it("refuses an audience it can't use, and adds nothing", async () => {
    for (const body of [{ audience: "chosen" }, { audience: "chosen", receptionistIds: "gastown" }, { audience: "nobody" }]) {
      const response = await create({ title: "Gastown parking", content: "Park on Water Street.", ...body });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_audience" });
    }
    expect(fixture.create).not.toHaveBeenCalled();
  });
});
