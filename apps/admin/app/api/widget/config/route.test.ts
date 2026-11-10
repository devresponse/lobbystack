import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const businessId = "00000000-0000-4000-8000-000000000001";
const visitorId = "00000000-0000-4000-8000-000000000002";

const mocks = vi.hoisted(() => ({
  registerWidgetVisitor: vi.fn(),
  touchWidgetKeyLastUsed: vi.fn(),
  voiceAllowed: true,
  recordingNotice: undefined as boolean | undefined,
  receptionistId: null as string | null,
  keyReceptionistId: null as string | null,
  config: { title: "Acme Dental" } as Record<string, unknown>,
  snapshot: vi.fn(),
}));

vi.mock("@/lib/widget-access", () => ({
  resolveWidgetSessionAccess: async () => ({
    ok: true,
    session: { businessId, widgetKeyId: "key-1", visitorId, origin: "https://business.test", businessName: "Acme Dental", businessSlug: "acme-dental", defaultLocale: "en", config: mocks.config, keyReceptionistId: mocks.keyReceptionistId, receptionistId: mocks.receptionistId },
  }),
}));
vi.mock("@/lib/widget-policy", () => ({ enforceWidgetRateLimits: async () => ({ allowed: true }) }));
vi.mock("@/lib/widget-keys", () => ({ requestIpHash: () => "ip-hash", touchWidgetKeyLastUsed: mocks.touchWidgetKeyLastUsed }));
vi.mock("@/lib/domain-context", () => ({ createWorkerDomainContext: () => ({}) }));
vi.mock("@/lib/api-helpers", () => ({ asApiResponse: (error: unknown) => { throw error; } }));
vi.mock("@lobbystack/domain", () => ({
  getCachedReceptionistSnapshot: mocks.snapshot,
  getWidgetChatAllowance: async () => ({ allowed: true, plan: "scale" }),
  getWebVoiceBillingAllowance: async () => ({ allowed: mocks.voiceAllowed }),
  registerWidgetVisitor: mocks.registerWidgetVisitor,
}));

import { GET } from "./route";

beforeEach(() => {
  mocks.registerWidgetVisitor.mockReset();
  mocks.touchWidgetKeyLastUsed.mockReset();
  mocks.voiceAllowed = true;
  mocks.recordingNotice = undefined;
  mocks.receptionistId = null;
  mocks.keyReceptionistId = null;
  mocks.config = { title: "Acme Dental" };
  mocks.snapshot.mockReset();
  mocks.snapshot.mockImplementation(async () => ({ greeting: "Hi! How can we help?", contactChannels: { phoneNumber: "+15145550100" }, ...(mocks.recordingNotice !== undefined ? { recordingNotice: mocks.recordingNotice } : {}) }));
  vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
});
afterEach(() => { vi.unstubAllEnvs(); });

async function config() {
  const response = await GET(new Request("http://localhost/api/widget/config", { headers: { authorization: "Bearer token" } }));
  return await response.json() as { voiceEnabled: boolean; recordingNotice: boolean; billing: { voiceAllowed: boolean } };
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
      recordingNotice: true,
    });
    expect(mocks.registerWidgetVisitor).not.toHaveBeenCalled();
    expect(mocks.touchWidgetKeyLastUsed).not.toHaveBeenCalled();
    // A key from before receptionists is answered by the default one.
    expect(mocks.snapshot).toHaveBeenCalledWith({}, { businessId, receptionistId: null });
  });

  it("answers with the receptionist the widget's key names, in its view of the business", async () => {
    const kitsilano = "00000000-0000-4000-8000-0000000000a2";
    mocks.receptionistId = kitsilano;
    mocks.snapshot.mockResolvedValueOnce({ greeting: "Hi, Kitsilano store!", contactChannels: {}, receptionist: { id: kitsilano, name: "Kitsilano", description: "The Kitsilano store.", isDefault: false } });
    const body = await (await GET(new Request("http://localhost/api/widget/config", { headers: { authorization: "Bearer token" } }))).json();
    expect(mocks.snapshot).toHaveBeenCalledWith({}, { businessId, receptionistId: kitsilano });
    expect(body).toMatchObject({ greeting: "Hi, Kitsilano store!", receptionist: { id: kitsilano, name: "Kitsilano", isDefault: false }, voiceEnabled: false });
    // Only what the widget shows: what it helps with stays out.
    expect(body.receptionist).not.toHaveProperty("description");
  });

  // The key's greeting is written for the receptionist the key names, the default one when it names none.
  it("leaves the key's greeting out on a page whose receptionist isn't the key's", async () => {
    const frontDesk = "00000000-0000-4000-8000-0000000000a1";
    const kitsilano = "00000000-0000-4000-8000-0000000000a2";
    const read = async () => await (await GET(new Request("http://localhost/api/widget/config", { headers: { authorization: "Bearer token" } }))).json() as { config: Record<string, unknown>; greeting?: string };
    mocks.config = { title: "Acme Dental", greeting: "Welcome to Acme!" };
    // The business page, through a key that names no receptionist: its default one answers.
    mocks.snapshot.mockResolvedValueOnce({ greeting: "Hi, the shop.", contactChannels: {}, receptionist: { id: frontDesk, name: "Front desk", isDefault: true } });
    expect(await read()).toMatchObject({ config: { greeting: "Welcome to Acme!" }, greeting: "Welcome to Acme!" });
    // Kitsilano's own page, through the same key.
    mocks.receptionistId = kitsilano;
    mocks.snapshot.mockResolvedValueOnce({ greeting: "Hi, Kitsilano store!", contactChannels: {}, receptionist: { id: kitsilano, name: "Kitsilano", isDefault: false } });
    const page = await read();
    expect(page.config).toEqual({ title: "Acme Dental" });
    expect(page.greeting).toBe("Hi, Kitsilano store!");
    // A key that names Kitsilano keeps its greeting there.
    mocks.keyReceptionistId = kitsilano;
    mocks.snapshot.mockResolvedValueOnce({ greeting: "Hi, Kitsilano store!", contactChannels: {}, receptionist: { id: kitsilano, name: "Kitsilano", isDefault: false } });
    expect(await read()).toMatchObject({ config: { greeting: "Welcome to Acme!" }, greeting: "Welcome to Acme!" });
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

  // A snapshot from before the switch has none, and its calls say the notice.
  it("says whether calls tell the caller they're with an AI and recorded", async () => {
    expect((await config()).recordingNotice).toBe(true);
    mocks.recordingNotice = false;
    expect((await config()).recordingNotice).toBe(false);
    mocks.recordingNotice = true;
    expect((await config()).recordingNotice).toBe(true);
  });
});
