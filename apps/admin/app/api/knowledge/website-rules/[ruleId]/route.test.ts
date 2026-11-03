import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ options: vi.fn(), remove: vi.fn() }));
const tx = vi.hoisted(() => ({ name: "tx" }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  withOperatorTransaction: async (_request: Request, callback: (input: unknown) => unknown, options: unknown) => {
    fixture.options(options);
    return await callback({ session: { user: { id: "owner" } }, businessId: "business", tx });
  },
}));
vi.mock("@lobbystack/domain", async (original) => ({ ...await original<typeof import("@lobbystack/domain")>(), deleteWebsiteRuleInTransaction: fixture.remove }));
import { DELETE } from "./route";

const RULE = "00000000-0000-4000-8000-0000000000f1";
const remove = (ruleId = RULE) => DELETE(new Request(`http://localhost:3000/api/knowledge/website-rules/${ruleId}`, { method: "DELETE" }), { params: Promise.resolve({ ruleId }) });

beforeEach(() => {
  vi.clearAllMocks();
  fixture.remove.mockResolvedValue(true);
});

it("deletes the rule for an owner or admin", async () => {
  const response = await remove(RULE.toUpperCase());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(fixture.remove).toHaveBeenCalledWith(tx, { businessId: "business", actorUserId: "owner", ruleId: RULE });
  expect(fixture.options).toHaveBeenCalledWith({ minimumRole: "business_admin" });
});

it("isn't found when the business has no such rule", async () => {
  fixture.remove.mockResolvedValue(false);
  const response = await remove();
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "Website rule not found.", code: "website_rule_not_found" });
});

it("never looks up what can't be a rule's id", async () => {
  expect((await remove("kitsilano")).status).toBe(404);
  expect(fixture.options).not.toHaveBeenCalled();
});
