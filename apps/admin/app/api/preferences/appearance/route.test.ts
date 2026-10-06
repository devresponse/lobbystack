import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withOperatorTransaction: vi.fn(), requireBusinessMembership: vi.fn() }));
vi.mock("@/lib/api-helpers", () => ({
  withOperatorTransaction: mocks.withOperatorTransaction,
  asApiResponse: (error: unknown) => { throw error; },
  jsonError: (message: string) => new Error(message),
  readJson: vi.fn(),
}));
vi.mock("@lobbystack/domain", () => ({
  requireBusinessMembership: mocks.requireBusinessMembership,
  hasMinimumRole: () => true,
}));

import { GET } from "./route";

beforeEach(() => {
  mocks.requireBusinessMembership.mockResolvedValue({ role: "business_admin" });
  const tx = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ telemetryEnabled: true }] }) }) }) };
  mocks.withOperatorTransaction.mockImplementation(async (_request, callback) => callback({ session: { user: { id: "operator" } }, businessId: "business", tx }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it("tells the browser the deployment mode the server runs with", async () => {
  vi.stubEnv("DEPLOYMENT_MODE", "cloud");
  const response = await GET(new Request("https://app.example/api/preferences/appearance?businessId=business"));
  expect(await response.json()).toEqual({ telemetryEnabled: true, canManageTenant: true, deploymentMode: "cloud" });
});
