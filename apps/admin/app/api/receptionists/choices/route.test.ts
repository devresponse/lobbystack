import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ options: vi.fn(), choices: vi.fn() }));
const tx = vi.hoisted(() => ({ name: "tx" }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  withOperatorTransaction: async (_request: Request, callback: (input: unknown) => unknown, options: unknown) => {
    fixture.options(options);
    return await callback({ session: { user: { id: "viewer" } }, businessId: "business", tx });
  },
}));
vi.mock("@lobbystack/domain", async (original) => ({ ...await original<typeof import("@lobbystack/domain")>(), listReceptionistChoicesInTransaction: fixture.choices }));
import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

it("gives every picker the receptionists that aren't archived, in the business's order, to anyone on the team", async () => {
  const receptionists = [{ id: "front-desk", name: "Front desk", isDefault: true }, { id: "gastown", name: "Gastown store", isDefault: false }];
  fixture.choices.mockResolvedValue(receptionists);
  const response = await GET(new Request("http://localhost:3000/api/receptionists/choices?businessId=business"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ receptionists });
  expect(fixture.choices).toHaveBeenCalledWith(tx, { businessId: "business" });
  expect(fixture.options).toHaveBeenCalledWith(undefined);
});
