import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const businessId = "00000000-0000-4000-8000-000000000001";
const visitorId = "00000000-0000-4000-8000-000000000002";

const mocks = vi.hoisted(() => ({
  registerWidgetVisitor: vi.fn(),
  touchWidgetKeyLastUsed: vi.fn(),
  voiceAllowed: true,
}));

vi.mock("@/lib/widget-access", () => ({
  resolveWidgetSessionAccess: async () => ({
    ok: true,
    session: { businessId, widgetKeyId: "key-1", visitorId, origin: "https://business.test", businessName: "Acme Dental", businessSlug: "acme-dental", defaultLocale: "en", config: { title: "Acme Dental" } },
  }),
}));
vi.mock("@/lib/widget-policy", () => ({ enforceWidgetRateLimits: async () => ({ allowed: true }) }));
vi.mock("@/lib/widget-keys", () => ({ requestIpHash: () => "ip-hash", touchWidgetKeyLastUsed: mocks.touchWidgetKeyLastUsed }));
vi.mock("@/lib/domain-context", () => ({ createWorkerDomainContext: () => ({}) }));
vi.mock("@/lib/api-helpers", () => ({ asApiResponse: (error: unknown) => { throw error; } }));
vi.mock("@lobbystack/domain", () => ({
  getCachedBusinessSnapshot: async () => ({ greeting: "Hi! How can we help?", contactChannels: { phoneNumber: "+15145550100" } }),
  getWidgetChatAllowance: async () => ({ allowed: true, plan: "scale" }),
  getWebVoiceBillingAllowance: async () => ({ allowed: mocks.voiceAllowed }),
  registerWidgetVisitor: mocks.registerWidgetVisitor,
}));

import { GET } from "./route";

beforeEach(() => {
  mocks.registerWidgetVisitor.mockReset();
  mocks.touchWidgetKeyLastUsed.mockReset();
  mocks.voiceAllowed = true;
  vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
});
afterEach(() => { vi.unstubAllEnvs(); });

async function config() {
  const response = await GET(new Request("http://localhost/api/widget/config", { headers: { authorization: "Bearer token" } }));
  return await response.json() as { voiceEnabled: boolean; billing: { voiceAllowed: boolean } };
}

describe("GET /api/widget/config", () => {
  it("sends the chat's settings without saving the visitor or the key's last use, which its session did", async () => {
    const response = await GET(new Request("http://localhost/api/widget/config", { headers: { authorization: "Bearer token" } }));

    expect(await response.json()).toEqual({
      key: "key-1",
      business: { id: businessId, name: "Acme Dental", defaultLocale: "en" },
      config: { title: "Acme Dental" },
      billing: { chatAllowed: true, plan: "scale", voiceAllowed: true },
      greeting: "Hi! How can we help?",
      snapshotPresent: true,
      businessSlug: "acme-dental",
      voiceEnabled: true,
    });
    expect(mocks.registerWidgetVisitor).not.toHaveBeenCalled();
    expect(mocks.touchWidgetKeyLastUsed).not.toHaveBeenCalled();
  });

  it("offers a call only when one can start", async () => {
    expect((await config()).voiceEnabled).toBe(true);
    // The business is out of minutes, as the call's start would say.
    mocks.voiceAllowed = false;
    expect(await config()).toMatchObject({ voiceEnabled: false, billing: { voiceAllowed: false } });
    mocks.voiceAllowed = true;
    // This deployment doesn't run live calls, or can't reach OpenAI.
    vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "false");
    expect((await config()).voiceEnabled).toBe(false);
    vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect((await config()).voiceEnabled).toBe(false);
  });
});
