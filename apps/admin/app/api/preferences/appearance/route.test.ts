import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withOperatorTransaction: vi.fn(), requireBusinessMembership: vi.fn(), updateBusinessTimezoneInTransaction: vi.fn(), readJson: vi.fn(), updates: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/api-helpers", () => ({
  withOperatorTransaction: mocks.withOperatorTransaction,
  asApiResponse: (error: unknown) => { throw error; },
  jsonError: (message: string) => new Error(message),
  readJson: mocks.readJson,
}));
vi.mock("@lobbystack/domain", () => ({
  requireBusinessMembership: mocks.requireBusinessMembership,
  hasMinimumRole: () => true,
  updateBusinessTimezoneInTransaction: mocks.updateBusinessTimezoneInTransaction,
}));

import { GET, PATCH } from "./route";

const tx = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ telemetryEnabled: true, timezone: "America/Toronto" }] }) }) }),
  update: () => ({ set: (values: Record<string, unknown>) => { mocks.updates.push(values); return { where: async () => undefined }; } }),
};
const patch = () => PATCH(new Request("https://app.example/api/preferences/appearance?businessId=business", { method: "PATCH" }));

beforeEach(() => {
  mocks.requireBusinessMembership.mockResolvedValue({ role: "business_admin" });
  mocks.withOperatorTransaction.mockImplementation(async (_request, callback) => callback({ session: { user: { id: "operator" } }, businessId: "business", tx }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  mocks.updates.length = 0;
});

it("tells the browser the deployment mode the server runs with", async () => {
  vi.stubEnv("DEPLOYMENT_MODE", "cloud");
  const response = await GET(new Request("https://app.example/api/preferences/appearance?businessId=business"));
  expect(await response.json()).toEqual({ telemetryEnabled: true, timezone: "America/Toronto", canManageTenant: true, deploymentMode: "cloud" });
});

it("saves the business timezone through the domain, which refreshes the receptionist", async () => {
  mocks.readJson.mockResolvedValue({ timezone: "America/Vancouver" });
  mocks.updateBusinessTimezoneInTransaction.mockResolvedValue("America/Vancouver");
  const response = await patch();
  expect(await response.json()).toEqual({ timezone: "America/Vancouver" });
  expect(mocks.updateBusinessTimezoneInTransaction).toHaveBeenCalledWith(tx, { businessId: "business", timezone: "America/Vancouver" });
  expect(mocks.updates).toEqual([]);
  // Only owners and admins change the business's settings.
  expect(mocks.withOperatorTransaction).toHaveBeenCalledWith(expect.any(Request), expect.any(Function), { minimumRole: "business_admin" });
});

it("still saves the telemetry preference on its own", async () => {
  mocks.readJson.mockResolvedValue({ telemetryEnabled: false });
  const response = await patch();
  expect(await response.json()).toEqual({ telemetryEnabled: false });
  expect(mocks.updates).toEqual([expect.objectContaining({ telemetryEnabled: false })]);
  expect(mocks.updateBusinessTimezoneInTransaction).not.toHaveBeenCalled();
});

it.each([
  [null, "Send telemetryEnabled or timezone."],
  [{}, "Send telemetryEnabled or timezone."],
  [{ telemetryEnabled: "yes" }, "telemetryEnabled must be a boolean."],
  [{ timezone: 5 }, "timezone must be a string."],
])("rejects the body %j", async (body, message) => {
  mocks.readJson.mockResolvedValue(body);
  await expect(patch()).rejects.toThrow(message);
  expect(mocks.updates).toEqual([]);
  expect(mocks.updateBusinessTimezoneInTransaction).not.toHaveBeenCalled();
});
