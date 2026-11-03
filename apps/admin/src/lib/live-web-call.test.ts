import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withOperatorTransaction: vi.fn(),
  resolveWebVoiceAccess: vi.fn(),
  verifyWidgetSessionToken: vi.fn(),
  widgetKey: { status: "active", allowedOrigins: ["https://client.example"] } as { status: string; allowedOrigins: string[]; receptionistId?: string | null; profilePublished?: boolean | null; profileWidgetKeyId?: string | null } | undefined,
}));

vi.mock("./api-helpers", () => ({
  withOperatorTransaction: mocks.withOperatorTransaction,
  getWorkerDatabase: () => ({ db: {} }),
}));
vi.mock("@lobbystack/db", async (original) => ({
  ...(await original<typeof import("@lobbystack/db")>()),
  withBusinessTransaction: vi.fn(async () => mocks.widgetKey),
}));
vi.mock("./prospect-demo", () => ({ resolveWebVoiceAccess: mocks.resolveWebVoiceAccess }));
vi.mock("./widget-keys", async (original) => ({
  ...(await original<typeof import("./widget-keys")>()),
  verifyWidgetSessionToken: mocks.verifyWidgetSessionToken,
}));

import { resolveLiveWebCallAccess } from "./live-web-call";

const app = "https://admin.lobbystack.test";
function request(headers: Record<string, string> = {}) {
  return new Request(`${app}/api/voice/live/session`, { method: "POST", headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_TRUSTED_ORIGINS", "");
  vi.stubEnv("APP_BASE_URL", app);
  mocks.widgetKey = { status: "active", allowedOrigins: ["https://client.example"] };
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("resolveLiveWebCallAccess", () => {
  it("lets an operator test-call their own business from the dashboard", async () => {
    mocks.withOperatorTransaction.mockResolvedValue("biz_1");
    await expect(resolveLiveWebCallAccess(request({ origin: app }), { sdp: "v=0", widgetId: "lobbystack-dashboard-test-call" })).resolves.toMatchObject({ businessId: "biz_1", dashboardTestCall: true, origin: app });
  });

  it("accepts the dashboard's origin when the proxy hands the app an internal URL", async () => {
    mocks.withOperatorTransaction.mockResolvedValue("biz_1");
    const internal = new Request("http://[::]:3000/api/voice/live/session", { method: "POST", headers: { origin: app } });
    await expect(resolveLiveWebCallAccess(internal, { sdp: "v=0", widgetId: "lobbystack-dashboard-test-call" })).resolves.toMatchObject({ businessId: "biz_1", dashboardTestCall: true, origin: app });
  });

  it("records the trusted origin the call came from, not the first configured one", async () => {
    vi.stubEnv("AUTH_TRUSTED_ORIGINS", "https://second.lobbystack.test");
    mocks.withOperatorTransaction.mockResolvedValue("biz_1");
    await expect(resolveLiveWebCallAccess(request({ origin: "https://second.lobbystack.test" }), { sdp: "v=0", widgetId: "lobbystack-dashboard-test-call" })).resolves.toMatchObject({ businessId: "biz_1", origin: "https://second.lobbystack.test" });
  });

  it("refuses a DNS-rebinding request whose host and origin match each other but not the app", async () => {
    const rebound = new Request("https://evil.example/api/voice/live/session", { method: "POST", headers: { origin: "https://evil.example" } });
    await expect(resolveLiveWebCallAccess(rebound, { sdp: "v=0", widgetId: "lobbystack-dashboard-test-call" })).resolves.toEqual({ status: 403, code: "origin_denied" });
    expect(mocks.withOperatorTransaction).not.toHaveBeenCalled();
  });

  it("refuses a dashboard test call started from another site", async () => {
    await expect(resolveLiveWebCallAccess(request({ origin: "https://evil.example" }), { sdp: "v=0", widgetId: "lobbystack-dashboard-test-call" })).resolves.toEqual({ status: 403, code: "origin_denied" });
    expect(mocks.withOperatorTransaction).not.toHaveBeenCalled();
  });

  it("accepts the widget's session token from the page it was issued to", async () => {
    mocks.verifyWidgetSessionToken.mockReturnValue({ businessId: "biz_2", widgetKeyId: "key_1", visitorId: "visitor_1", origin: "https://client.example" });
    await expect(resolveLiveWebCallAccess(request({ authorization: "Bearer token", "x-widget-parent-origin": "https://client.example" }), { sdp: "v=0", widgetId: "lobbystack-widget", visitorId: "visitor_1" }))
      .resolves.toMatchObject({ businessId: "biz_2", origin: "https://client.example", widgetId: "lobbystack-widget", visitorId: "visitor_1", dashboardTestCall: false });
  });

  it("rejects a widget token presented from a different page", async () => {
    mocks.verifyWidgetSessionToken.mockReturnValue({ businessId: "biz_2", widgetKeyId: "key_1", visitorId: "visitor_1", origin: "https://client.example" });
    await expect(resolveLiveWebCallAccess(request({ authorization: "Bearer token", "x-widget-parent-origin": "https://other.example" }), { sdp: "v=0", widgetId: "lobbystack-widget" })).resolves.toEqual({ status: 403, code: "widget_session_invalid" });
  });

  it("rejects a widget whose key was revoked", async () => {
    mocks.verifyWidgetSessionToken.mockReturnValue({ businessId: "biz_2", widgetKeyId: "key_1", visitorId: "visitor_1", origin: "https://client.example" });
    mocks.widgetKey = { status: "revoked", allowedOrigins: ["https://client.example"] };
    await expect(resolveLiveWebCallAccess(request({ authorization: "Bearer token", "x-widget-parent-origin": "https://client.example" }), { sdp: "v=0", widgetId: "lobbystack-widget" })).resolves.toEqual({ status: 403, code: "widget_origin_denied" });
  });

  it("accepts the widget on its business's published profile page, on the dashboard's domain", async () => {
    mocks.verifyWidgetSessionToken.mockReturnValue({ businessId: "biz_2", widgetKeyId: "key_1", visitorId: "visitor_1", origin: app });
    mocks.widgetKey = { status: "active", allowedOrigins: [], profilePublished: true, profileWidgetKeyId: "key_1" };
    await expect(resolveLiveWebCallAccess(request({ authorization: "Bearer token", "x-widget-parent-origin": app }), { sdp: "v=0", widgetId: "lobbystack-widget", visitorId: "visitor_1" }))
      .resolves.toMatchObject({ businessId: "biz_2", origin: app, widgetId: "lobbystack-widget", dashboardTestCall: false });
  });

  it.each([
    ["the page isn't published", { profilePublished: false, profileWidgetKeyId: "key_1" }],
    ["the page shows another widget", { profilePublished: true, profileWidgetKeyId: "key_9" }],
    ["the business has no page", { profilePublished: null, profileWidgetKeyId: null }],
  ])("refuses a widget on the dashboard's domain when %s", async (_case, profile) => {
    mocks.verifyWidgetSessionToken.mockReturnValue({ businessId: "biz_2", widgetKeyId: "key_1", visitorId: "visitor_1", origin: app });
    mocks.widgetKey = { status: "active", allowedOrigins: [], ...profile };
    await expect(resolveLiveWebCallAccess(request({ authorization: "Bearer token", "x-widget-parent-origin": app }), { sdp: "v=0", widgetId: "lobbystack-widget" })).resolves.toEqual({ status: 403, code: "widget_origin_denied" });
  });

  it("refuses a paused widget on its business's profile page", async () => {
    mocks.verifyWidgetSessionToken.mockReturnValue({ businessId: "biz_2", widgetKeyId: "key_1", visitorId: "visitor_1", origin: app });
    mocks.widgetKey = { status: "disabled", allowedOrigins: [], profilePublished: true, profileWidgetKeyId: "key_1" };
    await expect(resolveLiveWebCallAccess(request({ authorization: "Bearer token", "x-widget-parent-origin": app }), { sdp: "v=0", widgetId: "lobbystack-widget" })).resolves.toEqual({ status: 403, code: "widget_origin_denied" });
  });

  describe("the receptionist a call is for", () => {
    const kitsilanoId = "00000000-0000-4000-8000-0000000000a2";

    it("tests the receptionist the dashboard picks, and refuses an id that isn't one", async () => {
      mocks.withOperatorTransaction.mockResolvedValue("biz_1");
      await expect(resolveLiveWebCallAccess(request({ origin: app }), { sdp: "v=0", widgetId: "lobbystack-dashboard-test-call", receptionistId: kitsilanoId.toUpperCase() })).resolves.toMatchObject({ businessId: "biz_1", dashboardTestCall: true, receptionistId: kitsilanoId });
      await expect(resolveLiveWebCallAccess(request({ origin: app }), { sdp: "v=0", widgetId: "lobbystack-dashboard-test-call", receptionistId: "kitsilano" })).resolves.toEqual({ status: 400, code: "invalid_receptionist" });
    });

    it("tests the default receptionist when the dashboard picks none", async () => {
      mocks.withOperatorTransaction.mockResolvedValue("biz_1");
      expect(await resolveLiveWebCallAccess(request({ origin: app }), { sdp: "v=0", widgetId: "lobbystack-dashboard-test-call" })).not.toHaveProperty("receptionistId");
    });

    it("answers a widget call as the receptionist its key names, never one the request names", async () => {
      mocks.verifyWidgetSessionToken.mockReturnValue({ businessId: "biz_2", widgetKeyId: "key_1", visitorId: "visitor_1", origin: "https://client.example" });
      mocks.widgetKey = { status: "active", allowedOrigins: ["https://client.example"], receptionistId: kitsilanoId };
      const headers = { authorization: "Bearer token", "x-widget-parent-origin": "https://client.example" };
      await expect(resolveLiveWebCallAccess(request(headers), { sdp: "v=0", widgetId: "lobbystack-widget", receptionistId: "00000000-0000-4000-8000-0000000000a9" })).resolves.toMatchObject({ businessId: "biz_2", dashboardTestCall: false, receptionistId: kitsilanoId });
      // A key from before receptionists names none, and the default one answers.
      mocks.widgetKey = { status: "active", allowedOrigins: ["https://client.example"], receptionistId: null };
      expect(await resolveLiveWebCallAccess(request(headers), { sdp: "v=0", widgetId: "lobbystack-widget", receptionistId: kitsilanoId })).not.toHaveProperty("receptionistId");
    });

    it("answers a call from a receptionist's page as the receptionist the page's signed token named", async () => {
      const frontDeskId = "00000000-0000-4000-8000-0000000000a1";
      // The session carries the receptionist the page signed for; the key on the page names another.
      mocks.verifyWidgetSessionToken.mockReturnValue({ businessId: "biz_2", widgetKeyId: "key_1", visitorId: "visitor_1", origin: app, receptionistId: kitsilanoId });
      mocks.widgetKey = { status: "active", allowedOrigins: [], receptionistId: frontDeskId, profilePublished: true, profileWidgetKeyId: "key_1" };
      await expect(resolveLiveWebCallAccess(request({ authorization: "Bearer token", "x-widget-parent-origin": app }), { sdp: "v=0", widgetId: "lobbystack-widget" })).resolves.toMatchObject({ businessId: "biz_2", receptionistId: kitsilanoId });
    });
  });

  it("runs prospect demos under their demo", async () => {
    mocks.resolveWebVoiceAccess.mockResolvedValue({ allowed: true, businessId: "biz_3", mode: "prospect_demo", prospectDemoId: "demo_1" });
    await expect(resolveLiveWebCallAccess(request(), { sdp: "v=0", widgetId: "lobbystack-prospect-demo", businessSlug: "acme", prospectDemoToken: "secret" })).resolves.toMatchObject({ businessId: "biz_3", prospectDemoId: "demo_1" });
  });

  it("allows the landing demo only from an allowed origin", async () => {
    vi.stubEnv("WEB_CALL_PUBLIC_BUSINESS_SLUG", "lobbystack-demo");
    vi.stubEnv("WEB_CALL_ALLOWED_ORIGINS", "https://lobbystack.com");
    mocks.resolveWebVoiceAccess.mockResolvedValue({ allowed: true, businessId: "biz_4", mode: "normal" });
    await expect(resolveLiveWebCallAccess(request({ origin: "https://lobbystack.com" }), { sdp: "v=0", widgetId: "lobbystack-landing", businessSlug: "lobbystack-demo" })).resolves.toMatchObject({ businessId: "biz_4", origin: "https://lobbystack.com" });
    await expect(resolveLiveWebCallAccess(request({ origin: "https://evil.example" }), { sdp: "v=0", widgetId: "lobbystack-landing", businessSlug: "lobbystack-demo" })).resolves.toEqual({ status: 403, code: "web_voice_authorization_required" });
  });
});
