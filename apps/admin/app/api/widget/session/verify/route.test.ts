import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  verifyToken: vi.fn(),
  mint: vi.fn(),
  ip: vi.fn(),
  limit: vi.fn(),
  required: vi.fn(),
  turnstile: vi.fn(),
  clientIp: vi.fn(),
  report: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@lobbystack/domain", () => ({ bearerToken: (header: string | null) => header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null }));
vi.mock("@lobbystack/telemetry/node", () => ({ logEvent: mocks.log }));
// As the real one: a body that isn't JSON is a 400 the route passes on.
vi.mock("@/lib/api-helpers", async () => {
  const { NextResponse: Responses } = await import("next/server");
  return { readJson: async (request: Request) => await request.json().catch(() => { throw Responses.json({ error: "Invalid JSON body.", code: "invalid_json" }, { status: 400 }); }) };
});
vi.mock("@/lib/error-reporting", () => ({ reportServerError: mocks.report }));
vi.mock("@/lib/trusted-client-ip", () => ({ trustedClientIp: mocks.clientIp }));
vi.mock("@/lib/turnstile", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/turnstile")>(), verifyTurnstile: mocks.turnstile }));
vi.mock("@/lib/widget-access", () => ({ resolveWidgetSessionAccess: mocks.access }));
vi.mock("@/lib/widget-challenge", () => ({ widgetChallengeRequired: mocks.required }));
vi.mock("@/lib/widget-keys", () => ({ createWidgetSessionToken: mocks.mint, requestIpHash: mocks.ip, verifyWidgetSessionToken: mocks.verifyToken }));
vi.mock("@/lib/widget-policy", () => ({ enforceWidgetRateLimits: mocks.limit }));

import { TurnstileError } from "@/lib/turnstile";
import { POST } from "./route";

const visitorId = "5ef3b4ef-720d-47a7-8320-e6f4707a64e2";
const receptionistId = "00000000-0000-4000-8000-0000000000a2";
const payload = { v: 1, widgetKeyId: "key", businessId: "business", visitorId, origin: "https://business.test", exp: 1_900_000_000, receptionistId };

function request(body: unknown = { turnstileToken: "turnstile-token" }): Request {
  return new Request("https://admin.test/api/widget/session/verify", {
    method: "POST",
    headers: { authorization: "Bearer loader-session", "content-type": "application/json", "x-widget-parent-origin": "https://business.test" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("the website chat's Turnstile check (AUDIT-004)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.required.mockReturnValue(true);
    mocks.access.mockResolvedValue({ ok: true, session: { businessId: "business", widgetKeyId: "key", visitorId, origin: "https://business.test" } });
    mocks.verifyToken.mockReturnValue(payload);
    mocks.ip.mockReturnValue("ip-hash");
    mocks.limit.mockResolvedValue({ allowed: true });
    mocks.clientIp.mockReturnValue("203.0.113.7");
    mocks.turnstile.mockResolvedValue(undefined);
    mocks.mint.mockReturnValue({ token: "checked-session", expiresAt: "2030-01-01T01:00:00.000Z", expiresIn: 3600 });
  });

  it("signs the loader's session as checked once Cloudflare accepts the token", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-14T12:00:00Z"), toFake: ["Date"] });
    try {
      const response = await POST(request());
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ token: "checked-session", expiresAt: "2030-01-01T01:00:00.000Z", expiresIn: 3600, visitorId });
    } finally {
      vi.useRealTimers();
    }
    expect(mocks.verifyToken).toHaveBeenCalledWith("loader-session");
    // The visitor's address goes to Cloudflare only from the trusted header.
    expect(mocks.turnstile).toHaveBeenCalledExactlyOnceWith({ token: "turnstile-token", remoteIp: "203.0.113.7" });
    // Exactly what the loader's session signed, the page's receptionist included, plus when it passed.
    expect(mocks.mint).toHaveBeenCalledExactlyOnceWith({ widgetKeyId: "key", businessId: "business", visitorId, origin: "https://business.test", receptionistId, verifiedAt: Math.floor(Date.parse("2026-11-14T12:00:00Z") / 1000) });
  });

  it("keeps a session without a receptionist without one", async () => {
    mocks.verifyToken.mockReturnValue({ ...payload, receptionistId: undefined });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.mint.mock.calls[0]![0]).not.toHaveProperty("receptionistId");
  });

  it("asks Cloudflare without an address when the deployment trusts no header", async () => {
    mocks.clientIp.mockReturnValue(undefined);
    expect((await POST(request())).status).toBe(200);
    expect(mocks.turnstile).toHaveBeenCalledWith({ token: "turnstile-token", remoteIp: null });
  });

  it("has nothing to check on a deployment without the check", async () => {
    mocks.required.mockReturnValue(false);
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "widget_challenge_off" });
    expect(mocks.turnstile).not.toHaveBeenCalled();
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it.each([
    ["no token", {}],
    ["an empty token", { turnstileToken: "" }],
    ["a token longer than Turnstile's", { turnstileToken: "x".repeat(2049) }],
  ])("refuses %s before asking anyone", async (_label, body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "widget_challenge_input_invalid" });
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.turnstile).not.toHaveBeenCalled();
  });

  it("refuses a body that isn't JSON", async () => {
    const response = await POST(request("not json"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_json" });
    expect(mocks.turnstile).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it("passes on the session check's refusal", async () => {
    mocks.access.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Expired.", code: "widget_session_invalid" }, { status: 401 }) });
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.turnstile).not.toHaveBeenCalled();
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("refuses a session whose token doesn't verify again", async () => {
    mocks.verifyToken.mockReturnValue(null);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "widget_session_invalid" });
    expect(mocks.turnstile).not.toHaveBeenCalled();
  });

  it("spends the check's own budget before asking Cloudflare", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.limit).toHaveBeenCalledWith({ businessId: "business", widgetKeyId: "key", visitorId, ipHash: "ip-hash", operation: "verify" });
    expect(mocks.limit.mock.invocationCallOrder[0]).toBeLessThan(mocks.turnstile.mock.invocationCallOrder[0]!);
  });

  it.each([429, 503])("stops at the limit (%s)", async (status) => {
    mocks.limit.mockResolvedValue({ allowed: false, status, code: "widget_rate_limited", reason: "rate_limit_ip_hour" });
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code: "widget_rate_limited" });
    expect(mocks.turnstile).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith("warn", "widget.verify_refused", expect.objectContaining({ status, reason: "rate_limit_ip_hour" }));
  });

  it.each([["rejected", 403, "widget_challenge_failed"], ["missing", 403, "widget_challenge_failed"], ["unavailable", 503, "widget_challenge_unavailable"]] as const)("answers a %s token with %s", async (reason, status, code) => {
    mocks.turnstile.mockRejectedValue(new TurnstileError("Turnstile verification failed.", reason));
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith("warn", "widget.verify_refused", expect.objectContaining({ status, code }));
  });

  it.each([
    ["a deployment that lost its secret key", new TurnstileError("Turnstile is not configured.", "not_configured")],
    ["anything else that broke", new Error("boom")],
  ])("reports %s, and signs nothing", async (_label, failure) => {
    mocks.turnstile.mockRejectedValue(failure);
    const response = await POST(request());
    expect(response.status).toBe(500);
    const body = await response.json() as { code: string; errorId: string };
    expect(body).toMatchObject({ code: "widget_challenge_error", errorId: expect.any(String) });
    expect(response.headers.get("x-error-id")).toBe(body.errorId);
    expect(mocks.mint).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledExactlyOnceWith(failure, { operation: "widget_session_verify", errorId: body.errorId, route: "/api/widget/session/verify" }));
  });
});
