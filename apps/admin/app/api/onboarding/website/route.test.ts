import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOperatorBusiness: vi.fn(),
  saveOnboardingWebsite: vi.fn(),
  createKnowledgeDocument: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({
  requireOperatorBusiness: mocks.requireOperatorBusiness,
  readJson: async (request: Request) => await request.json(),
  jsonError: (error: string, status = 400, code?: string) => Response.json({ error, ...(code ? { code } : {}) }, { status }),
  asApiResponse: (error: { status?: number; code?: string; message?: string }) => Response.json({ error: error.status && error.status < 500 ? error.message : "Request failed.", ...(error.code ? { code: error.code } : {}) }, { status: error.status ?? 500 }),
}));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: "app-db" }) }));
vi.mock("@lobbystack/domain", () => ({
  saveOnboardingWebsite: mocks.saveOnboardingWebsite,
  createKnowledgeDocument: mocks.createKnowledgeDocument,
}));

import { POST } from "./route";

const url = "https://app.example.test/api/onboarding/website?businessId=business-1";
function post(body: unknown) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  mocks.requireOperatorBusiness.mockResolvedValue({ session: { user: { id: "user-1" } }, businessId: "business-1" });
});
afterEach(() => { vi.resetAllMocks(); });

describe("onboarding website step", () => {
  it("saves the website and moves on without adding a knowledge source", async () => {
    mocks.saveOnboardingWebsite.mockResolvedValue({ websiteUrl: "https://example.com/", stage: "knowledge" });
    const response = await POST(post({ websiteUrl: "example.com" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, websiteUrl: "https://example.com/", stage: "knowledge" });
    expect(mocks.saveOnboardingWebsite).toHaveBeenCalledWith({ db: "app-db" }, { userId: "user-1", businessId: "business-1", websiteUrl: "example.com" });
    expect(mocks.createKnowledgeDocument).not.toHaveBeenCalled();
  });

  it.each([[""], ["   "], [42], [null], ["x".repeat(2_001)]])("rejects %j before reaching the domain", async (websiteUrl) => {
    const response = await POST(post({ websiteUrl }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "website_url_invalid" });
    expect(mocks.saveOnboardingWebsite).not.toHaveBeenCalled();
  });

  it("passes on the domain's answer for an address it can't use", async () => {
    mocks.saveOnboardingWebsite.mockRejectedValue(Object.assign(new Error("Website URL must use a public hostname."), { status: 422, code: "website_url_invalid" }));
    const response = await POST(post({ websiteUrl: "localhost" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Website URL must use a public hostname.", code: "website_url_invalid" });
  });

  it("requires a session", async () => {
    mocks.requireOperatorBusiness.mockRejectedValue(Object.assign(new Error("Authentication required."), { status: 401, code: "unauthorized" }));
    const response = await POST(post({ websiteUrl: "example.com" }));
    expect(response.status).toBe(401);
    expect(mocks.saveOnboardingWebsite).not.toHaveBeenCalled();
  });
});
