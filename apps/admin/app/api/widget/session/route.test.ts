import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), mint: vi.fn(), limit: vi.fn(), ip: vi.fn(), register: vi.fn(), touch: vi.fn(), report: vi.fn(), pageReceptionist: vi.fn() }));
vi.mock("@/lib/api-helpers", () => ({ readJson: (request: Request) => request.json() }));
vi.mock("@/lib/domain-context", () => ({ createWorkerDomainContext: () => ({}) }));
vi.mock("@/lib/error-reporting", () => ({ reportServerError: mocks.report }));
vi.mock("@/lib/widget-access", () => ({ resolveWidgetAccess: mocks.access }));
vi.mock("@/lib/widget-keys", () => ({ createWidgetSessionToken: mocks.mint, requestIpHash: mocks.ip, touchWidgetKeyLastUsed: mocks.touch }));
vi.mock("@/lib/widget-policy", () => ({ enforceWidgetRateLimits: mocks.limit }));
vi.mock("@/lib/widget-receptionist", () => ({ receptionistFromPageToken: mocks.pageReceptionist }));
vi.mock("@lobbystack/domain", () => ({ registerWidgetVisitor: mocks.register }));
import { POST } from "./route";

const visitorId = "5ef3b4ef-720d-47a7-8320-e6f4707a64e2";
const request = (extra: Record<string, unknown> = {}) => new Request("https://admin.test/api/widget/session", { method: "POST", headers: { origin: "https://business.test", "content-type": "application/json", "user-agent": "Visitor browser" }, body: JSON.stringify({ widgetKey: "widget-key", visitorId, ...extra }) });

describe("widget session admission", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.access.mockResolvedValue({ ok: true, session: { businessId: "business", widgetKeyId: "key", origin: "https://business.test" } });
    mocks.ip.mockReturnValue("trusted-ip-hash");
    mocks.mint.mockReturnValue({ token: "signed", expiresAt: "2026-10-01T00:00:00.000Z" });
    mocks.register.mockResolvedValue({ visitorId, contactId: null });
    mocks.touch.mockResolvedValue(undefined);
  });
  it.each([429, 503])("does not mint when policy denies with %s", async (status) => {
    mocks.limit.mockResolvedValue({ allowed: false, status, code: "widget_rate_limited" });
    expect((await POST(request())).status).toBe(status);
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.touch).not.toHaveBeenCalled();
  });
  // The loader on the customer's site can only read the code, and tell the
  // visitor why, when the refusal carries CORS headers.
  it.each([
    [403, "widget_origin_denied"],
    [403, "widget_disabled"],
    [404, "widget_key_invalid"],
  ])("lets the customer's site read a %s %s refusal", async (status, code) => {
    mocks.access.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Refused.", code }, { status }) });
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://business.test");
    expect(response.headers.get("vary")).toBe("Origin");
    expect(await response.json()).toMatchObject({ code });
    expect(mocks.mint).not.toHaveBeenCalled();
  });
  it("lets the customer's site read a refusal thrown while checking access", async () => {
    mocks.access.mockRejectedValue(NextResponse.json({ error: "Unavailable.", code: "widget_unavailable" }, { status: 503 }));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://business.test");
    expect(await response.json()).toMatchObject({ code: "widget_unavailable" });
    // A refusal is an answer, not a failure to report.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("consumes the tenant, visitor and trusted IP budget before signing", async () => {
    mocks.limit.mockResolvedValue({ allowed: true });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.limit).toHaveBeenCalledWith({ businessId: "business", widgetKeyId: "key", visitorId, ipHash: "trusted-ip-hash", operation: "session" });
    expect(mocks.limit.mock.invocationCallOrder[0]).toBeLessThan(mocks.mint.mock.invocationCallOrder[0]!);
  });
  // The chat's own requests rely on the session having saved both.
  it("saves the visitor, with its browser and website, and the key's last use before signing", async () => {
    mocks.limit.mockResolvedValue({ allowed: true });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.register).toHaveBeenCalledExactlyOnceWith({}, { businessId: "business", visitorId, metadata: { userAgent: "Visitor browser", pageUrl: "https://business.test" } });
    expect(mocks.touch).toHaveBeenCalledExactlyOnceWith({ businessId: "business", widgetKeyId: "key" });
    expect(mocks.register.mock.invocationCallOrder[0]).toBeLessThan(mocks.mint.mock.invocationCallOrder[0]!);
    expect(mocks.touch.mock.invocationCallOrder[0]).toBeLessThan(mocks.mint.mock.invocationCallOrder[0]!);
  });
  it("signs no session when the visitor can't be saved, and reports why", async () => {
    mocks.limit.mockResolvedValue({ allowed: true });
    const failure = new Error("database unavailable");
    mocks.register.mockRejectedValue(failure);
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://business.test");
    const body = await response.json() as { code: string; errorId: string };
    expect(body).toMatchObject({ code: "widget_session_failed", errorId: expect.any(String) });
    expect(response.headers.get("x-error-id")).toBe(body.errorId);
    expect(mocks.mint).not.toHaveBeenCalled();
    // Logged and reported like any route's server error, under the ID the response carries.
    await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledExactlyOnceWith(failure, { operation: "widget_session", errorId: body.errorId, route: "/api/widget/session" }));
  });
  it("still signs the session when the key's last use can't be saved, and reports that", async () => {
    mocks.limit.mockResolvedValue({ allowed: true });
    const failure = new Error("lock timeout");
    mocks.touch.mockRejectedValue(failure);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: "signed", expiresAt: "2026-10-01T00:00:00.000Z", visitorId });
    expect(mocks.register).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledExactlyOnceWith(failure, { operation: "widget_key_last_used", route: "/api/widget/session" }));
  });
  describe("the receptionist a page names", () => {
    const kitsilano = "00000000-0000-4000-8000-0000000000a2";
    beforeEach(() => mocks.limit.mockResolvedValue({ allowed: true }));

    it("puts the receptionist the page's signed token names in the session", async () => {
      mocks.pageReceptionist.mockResolvedValue(kitsilano);
      expect((await POST(request({ receptionistToken: "page-token" }))).status).toBe(200);
      expect(mocks.pageReceptionist).toHaveBeenCalledExactlyOnceWith("page-token", { businessId: "business", widgetKeyId: "key" });
      expect(mocks.mint).toHaveBeenCalledExactlyOnceWith({ widgetKeyId: "key", businessId: "business", visitorId, origin: "https://business.test", receptionistId: kitsilano });
    });

    it("leaves the session to the widget's key when the token doesn't check out", async () => {
      mocks.pageReceptionist.mockResolvedValue(undefined);
      expect((await POST(request({ receptionistToken: "stale-token" }))).status).toBe(200);
      expect(mocks.mint).toHaveBeenCalledExactlyOnceWith({ widgetKeyId: "key", businessId: "business", visitorId, origin: "https://business.test" });
    });

    it("checks nothing on a website that sends no token", async () => {
      expect((await POST(request())).status).toBe(200);
      expect(mocks.pageReceptionist).not.toHaveBeenCalled();
      expect(mocks.mint.mock.calls[0]![0]).not.toHaveProperty("receptionistId");
    });

    it("refuses a token longer than any page signs", async () => {
      const response = await POST(request({ receptionistToken: "x".repeat(2049) }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "widget_session_input_invalid" });
      expect(mocks.pageReceptionist).not.toHaveBeenCalled();
    });

    it("never names a receptionist for a refused widget", async () => {
      mocks.access.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Refused.", code: "widget_origin_denied" }, { status: 403 }) });
      expect((await POST(request({ receptionistToken: "page-token" }))).status).toBe(403);
      expect(mocks.pageReceptionist).not.toHaveBeenCalled();
    });
  });
});
