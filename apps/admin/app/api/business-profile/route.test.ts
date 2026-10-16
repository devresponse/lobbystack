import { NextResponse } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withOperatorTransaction: vi.fn(),
  requireBusinessMembership: vi.fn(),
  getBusinessPublicProfileSettings: vi.fn(),
  updateBusinessPublicProfile: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({
  withOperatorTransaction: mocks.withOperatorTransaction,
  asApiResponse: (error: unknown) => (error instanceof NextResponse ? error : NextResponse.json({ error: String(error) }, { status: 500 })),
  readJson: async (request: Request) => await request.json(),
}));
vi.mock("@lobbystack/domain", async (importOriginal) => ({
  hasMinimumRole: (await importOriginal<typeof import("@lobbystack/domain")>()).hasMinimumRole,
  requireBusinessMembership: mocks.requireBusinessMembership,
  getBusinessPublicProfileSettings: mocks.getBusinessPublicProfileSettings,
  updateBusinessPublicProfile: mocks.updateBusinessPublicProfile,
}));

import { GET, PUT } from "./route";

const SETTINGS = {
  published: true,
  category: "Dental clinic",
  description: "Family dentistry.",
  address: { line1: "123 Main St", line2: null, city: "Toronto", region: "ON", postalCode: "M5V 2T6", countryCode: "CA" },
  publicEmail: "hello@acmedental.example",
  showPhone: true,
  showHours: true,
  showServices: true,
  showMap: true,
  widgetKeyId: null,
};

const VIEW = { saved: true, slug: "acme-dental", businessName: "Acme Dental", publishedAt: "2026-10-16T20:00:00.000Z", settings: SETTINGS, widgetKeys: [] };

const tx = { name: "tx" };

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", "https://app.example.com");
  mocks.withOperatorTransaction.mockImplementation(async (_request, callback) => callback({ session: { user: { id: "operator" } }, businessId: "business", tx }));
  mocks.getBusinessPublicProfileSettings.mockResolvedValue(VIEW);
  mocks.updateBusinessPublicProfile.mockResolvedValue(VIEW);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

const put = (body: unknown) => new Request("https://app.example.com/api/business-profile?businessId=business", { method: "PUT", body: JSON.stringify(body) });

it("gives every member the settings and the page's address, and says who can change them", async () => {
  mocks.requireBusinessMembership.mockResolvedValue({ role: "business_admin" });
  const admin = await GET(new Request("https://app.example.com/api/business-profile?businessId=business"));
  expect(await admin.json()).toEqual({ ...VIEW, url: "https://app.example.com/profile/acme-dental", canEdit: true });
  expect(mocks.getBusinessPublicProfileSettings).toHaveBeenCalledWith(tx, { businessId: "business" });

  mocks.requireBusinessMembership.mockResolvedValue({ role: "scheduler" });
  const scheduler = await GET(new Request("https://app.example.com/api/business-profile?businessId=business"));
  expect(await scheduler.json()).toMatchObject({ canEdit: false });
});

it("saves the settings as an owner or admin", async () => {
  const response = await PUT(put({ ...SETTINGS, category: "  Dental   clinic ", address: { ...SETTINGS.address, countryCode: "ca" } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ url: "https://app.example.com/profile/acme-dental", canEdit: true });
  expect(mocks.withOperatorTransaction).toHaveBeenCalledWith(expect.any(Request), expect.any(Function), { minimumRole: "business_admin" });
  expect(mocks.updateBusinessPublicProfile).toHaveBeenCalledWith(tx, {
    businessId: "business",
    userId: "operator",
    settings: { ...SETTINGS, address: { ...SETTINGS.address, countryCode: "CA" } },
  });
});

it("names the field that can't be saved", async () => {
  const response = await PUT(put({ ...SETTINGS, publicEmail: "not an email" }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Enter an email address such as hello@example.com.", code: "public_profile_invalid", field: "publicEmail" });
  expect(mocks.updateBusinessPublicProfile).not.toHaveBeenCalled();

  const extra = await PUT(put({ ...SETTINGS, slug: "someone-else" }));
  expect(extra.status).toBe(400);
  expect(mocks.updateBusinessPublicProfile).not.toHaveBeenCalled();
});
