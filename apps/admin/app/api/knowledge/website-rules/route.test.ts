import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ options: vi.fn(), list: vi.fn(), create: vi.fn() }));
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
  listWebsiteRulesInTransaction: fixture.list,
  createWebsiteRuleInTransaction: fixture.create,
}));
import { GET, POST } from "./route";

const SITE = "00000000-0000-4000-8000-0000000000d0";
const KITSILANO = "00000000-0000-4000-8000-0000000000a2";
const rule = { id: "00000000-0000-4000-8000-0000000000f1", rootDocumentId: SITE, siteUrl: "https://kitscoffee.example", pathPrefix: "/stores/kitsilano/", receptionistId: KITSILANO, pages: 12 };
const add = (body: unknown) => POST(new Request("http://localhost:3000/api/knowledge/website-rules", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.list.mockResolvedValue([rule]);
  fixture.create.mockResolvedValue(rule);
});

it("lists the website rules with the pages each gave, to anyone on the team", async () => {
  const response = await GET(new Request("http://localhost:3000/api/knowledge/website-rules"));
  expect(await response.json()).toEqual({ rules: [rule] });
  expect(fixture.list).toHaveBeenCalledWith(tx, { businessId: "business" });
  expect(fixture.options).toHaveBeenCalledWith(undefined);
});

describe("adding a website rule", () => {
  it("gives a site's pages under a path to a receptionist, for an owner or admin", async () => {
    const response = await add({ rootDocumentId: SITE, pathPrefix: "https://kitscoffee.example/stores/kitsilano", receptionistId: KITSILANO });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ rule });
    expect(fixture.create).toHaveBeenCalledWith(tx, { businessId: "business", actorUserId: "owner", rule: { rootDocumentId: SITE, pathPrefix: "/stores/kitsilano/", receptionistId: KITSILANO } });
    expect(fixture.options).toHaveBeenCalledWith({ minimumRole: "business_admin" });
  });

  it.each([
    null,
    { pathPrefix: "/stores/", receptionistId: KITSILANO },
    { rootDocumentId: SITE, pathPrefix: "/stores/", receptionistId: "kitsilano" },
    { rootDocumentId: SITE, pathPrefix: "", receptionistId: KITSILANO },
    { rootDocumentId: SITE, pathPrefix: "/stores?id=1", receptionistId: KITSILANO },
  ])("refuses %j before opening a transaction", async (body) => {
    const response = await add(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_website_rule" });
    expect(fixture.options).not.toHaveBeenCalled();
  });

  it("says when the site already gives that path to that receptionist", async () => {
    fixture.create.mockRejectedValue(Object.assign(new Error("This site already gives that path to that receptionist."), { status: 409, code: "website_rule_exists" }));
    expect((await add({ rootDocumentId: SITE, pathPrefix: "/stores/kitsilano/", receptionistId: KITSILANO })).status).toBe(409);
  });
});
