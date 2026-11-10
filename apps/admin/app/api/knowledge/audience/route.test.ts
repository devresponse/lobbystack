import { beforeEach, describe, expect, it, vi } from "vitest";

// What the route reads and hands to the domain; the changes themselves are
// covered by knowledgeAudience.integration.test.ts.
const fixture = vi.hoisted(() => ({ denied: false, options: vi.fn(), links: vi.fn(), change: vi.fn() }));
const tx = vi.hoisted(() => ({ name: "tx" }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  withOperatorTransaction: async (_request: Request, callback: (input: unknown) => unknown, options: unknown) => {
    fixture.options(options);
    if (fixture.denied) throw Object.assign(new Error("Forbidden"), { status: 403 });
    return await callback({ session: { user: { id: "owner" } }, businessId: "business", tx });
  },
}));
vi.mock("@lobbystack/domain", async (original) => ({
  ...await original<typeof import("@lobbystack/domain")>(),
  knowledgeAudienceLinksInTransaction: fixture.links,
  changeKnowledgeAudienceInTransaction: fixture.change,
}));
import { GET, POST } from "./route";

const MENU = "00000000-0000-4000-8000-0000000000d1";
const PARKING = "00000000-0000-4000-8000-0000000000e1";
const GASTOWN = "00000000-0000-4000-8000-0000000000b2";
const RULE = "00000000-0000-4000-8000-0000000000f1";
const change = (body: unknown) => POST(new Request("http://localhost:3000/api/knowledge/audience", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.denied = false;
  fixture.links.mockResolvedValue({ documents: { [MENU]: [{ receptionistId: GASTOWN, websiteRuleId: RULE }] }, snippets: { [PARKING]: [GASTOWN] } });
  fixture.change.mockResolvedValue({ documents: 1, snippets: 1 });
});

it("gives the receptionists each chosen article is for, to anyone on the team", async () => {
  const response = await GET(new Request("http://localhost:3000/api/knowledge/audience"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ documents: { [MENU]: [{ receptionistId: GASTOWN, websiteRuleId: RULE }] }, snippets: { [PARKING]: [GASTOWN] } });
  expect(fixture.links).toHaveBeenCalledWith(tx, { businessId: "business" });
  expect(fixture.options).toHaveBeenCalledWith(undefined);
});

describe("changing who articles are for", () => {
  it("opens the articles selected to everyone", async () => {
    const response = await change({ documentIds: [MENU], snippetIds: [PARKING], audience: "everyone" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ documents: 1, snippets: 1 });
    expect(fixture.change).toHaveBeenCalledWith(tx, { businessId: "business", actorUserId: "owner", change: { documentIds: [MENU], snippetIds: [PARKING], audience: "everyone" } });
    expect(fixture.options).toHaveBeenCalledWith({ minimumRole: "business_admin" });
  });

  it("adds, removes or replaces the receptionists chosen", async () => {
    for (const mode of ["add", "remove", "replace"] as const) {
      await change({ snippetIds: [PARKING], audience: "chosen", mode, receptionistIds: [GASTOWN] });
      expect(fixture.change).toHaveBeenLastCalledWith(tx, { businessId: "business", actorUserId: "owner", change: { documentIds: [], snippetIds: [PARKING], audience: "chosen", mode, receptionistIds: [GASTOWN] } });
    }
  });

  it.each([
    null,
    { audience: "everyone" },
    { documentIds: ["menu"], audience: "everyone" },
    { documentIds: [MENU], audience: "some" },
    { documentIds: [MENU], audience: "chosen", mode: "add", receptionistIds: [] },
    { documentIds: [MENU], audience: "chosen", mode: "toggle", receptionistIds: [GASTOWN] },
    { documentIds: [MENU], audience: "chosen", receptionistIds: [GASTOWN] },
  ])("refuses %j before opening a transaction", async (body) => {
    expect((await change(body)).status).toBe(400);
    expect(fixture.options).not.toHaveBeenCalled();
  });

  it("refuses more articles than one change may cover", async () => {
    const documentIds = Array.from({ length: 501 }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);
    const response = await change({ documentIds, audience: "everyone" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_articles" });
  });

  it("passes on why the domain refused, such as an archived receptionist", async () => {
    fixture.change.mockRejectedValue(Object.assign(new Error("An archived receptionist can't be chosen. Restore it first."), { status: 409, code: "receptionist_archived" }));
    const response = await change({ documentIds: [MENU], audience: "chosen", mode: "add", receptionistIds: [GASTOWN] });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "An archived receptionist can't be chosen. Restore it first.", code: "receptionist_archived" });
  });

  it("leaves viewers and schedulers out", async () => {
    fixture.denied = true;
    expect((await change({ documentIds: [MENU], audience: "everyone" })).status).toBe(403);
    expect(fixture.change).not.toHaveBeenCalled();
  });
});
