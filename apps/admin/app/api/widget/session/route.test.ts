import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), mint: vi.fn(), limit: vi.fn(), ip: vi.fn() }));
vi.mock("@/lib/api-helpers", () => ({ readJson: (request: Request) => request.json() }));
vi.mock("@/lib/widget-access", () => ({ resolveWidgetAccess: mocks.access }));
vi.mock("@/lib/widget-keys", () => ({ createWidgetSessionToken: mocks.mint, requestIpHash: mocks.ip }));
vi.mock("@/lib/widget-policy", () => ({ enforceWidgetRateLimits: mocks.limit }));
import { POST } from "./route";

const visitorId = "5ef3b4ef-720d-47a7-8320-e6f4707a64e2";
const request = () => new Request("https://admin.test/api/widget/session", { method: "POST", headers: { origin: "https://business.test", "content-type": "application/json" }, body: JSON.stringify({ widgetKey: "widget-key", visitorId }) });

describe("widget session admission", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.access.mockResolvedValue({ ok: true, session: { businessId: "business", widgetKeyId: "key", origin: "https://business.test" } });
    mocks.ip.mockReturnValue("trusted-ip-hash");
    mocks.mint.mockReturnValue({ token: "signed", expiresAt: "2026-10-01T00:00:00.000Z" });
  });
  it.each([429, 503])("does not mint when policy denies with %s", async (status) => {
    mocks.limit.mockResolvedValue({ allowed: false, status, code: "widget_rate_limited" });
    expect((await POST(request())).status).toBe(status);
    expect(mocks.mint).not.toHaveBeenCalled();
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
  });
  it("consumes the tenant, visitor and trusted IP budget before signing", async () => {
    mocks.limit.mockResolvedValue({ allowed: true });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.limit).toHaveBeenCalledWith({ businessId: "business", widgetKeyId: "key", visitorId, ipHash: "trusted-ip-hash", operation: "session" });
    expect(mocks.limit.mock.invocationCallOrder[0]).toBeLessThan(mocks.mint.mock.invocationCallOrder[0]!);
  });
});
