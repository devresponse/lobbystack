import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  requireApiSession: async () => ({ user: { id: "user_1" } }),
}));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: "app" }) }));
vi.mock("@lobbystack/domain", async (original) => ({
  ...await original<typeof import("@lobbystack/domain")>(),
  createKnowledgeDocument: fixture.create,
}));

import { POST } from "./route";

const GASTOWN = "00000000-0000-4000-8000-0000000000b2";
const KITSILANO = "00000000-0000-4000-8000-0000000000b3";
const site = { businessId: "business_1", title: "https://kitsilanocoffee.ca", sourceType: "website", sourceUrl: "https://kitsilanocoffee.ca" };
const add = (body: unknown) => POST(new Request("http://localhost:3000/api/knowledge?businessId=business_1", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.create.mockResolvedValue("document_1");
});

describe("adding a website", () => {
  it("adds it as before when it names no page rules", async () => {
    const response = await add(site);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ documentId: "document_1" });
    expect(fixture.create).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", title: site.title, sourceType: "website", onboarding: false, sourceUrl: site.sourceUrl });
  });

  it("adds its page rules with it, each path in the form the rules keep, each once", async () => {
    expect((await add({ ...site, websiteRules: [
      { pathPrefix: "stores/gastown", receptionistId: GASTOWN },
      { pathPrefix: "https://kitsilanocoffee.ca/stores/kitsilano/", receptionistId: KITSILANO.toUpperCase() },
      { pathPrefix: "/stores/gastown/", receptionistId: GASTOWN },
    ] })).status).toBe(201);
    expect(fixture.create).toHaveBeenCalledWith({ db: "app" }, expect.objectContaining({ websiteRules: [
      { pathPrefix: "/stores/gastown/", receptionistId: GASTOWN },
      { pathPrefix: "/stores/kitsilano/", receptionistId: KITSILANO },
    ] }));
  });

  it("refuses page rules it can't use, and adds nothing", async () => {
    for (const websiteRules of ["/stores/", [{ pathPrefix: "/stores?id=1", receptionistId: GASTOWN }], [{ pathPrefix: "/stores/" }], [null]]) {
      const response = await add({ ...site, websiteRules });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_website_rule" });
    }
    expect(fixture.create).not.toHaveBeenCalled();
  });
});
