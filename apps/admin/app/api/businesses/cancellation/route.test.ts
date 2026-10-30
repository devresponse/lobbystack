import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ request: vi.fn(), preview: vi.fn(), enforce: vi.fn(), log: vi.fn(), locale: vi.fn() }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  requireApiSession: async () => ({ user: { id: "user_1" } }),
}));
vi.mock("@/lib/auth", () => ({ getAuthDatabase: () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: fixture.locale }) }) }) } }) }));
vi.mock("@/lib/fixed-window-limit", async (original) => ({ ...await original<typeof import("@/lib/fixed-window-limit")>(), enforceFixedWindow: fixture.enforce }));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: "app" }) }));
vi.mock("@lobbystack/domain", () => ({ requestBusinessCancellation: fixture.request, previewBusinessCancellation: fixture.preview }));
vi.mock("@lobbystack/telemetry/node", async (original) => ({ ...await original<typeof import("@lobbystack/telemetry/node")>(), logEvent: fixture.log }));

import { GET, POST } from "./route";

const expiresAt = new Date("2026-10-31T15:11:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  fixture.enforce.mockResolvedValue({ allowed: true });
  fixture.locale.mockResolvedValue([{ locale: "fr" }]);
  fixture.request.mockResolvedValue({ email: "owner@example.test", expiresAt, inboxNotified: true });
});
afterEach(() => { vi.useRealTimers(); });

function cancelRequest(body: unknown, query = "?businessId=business_1") {
  return new Request(`http://localhost:3000/api/businesses/cancellation${query}`, { method: "POST", body: JSON.stringify(body) });
}

function refusal(code: string, status: number, message: string) {
  return Object.assign(new Error(message), { status, code });
}

describe("asking to cancel a business through the API", () => {
  it("asks for the business the query names, as the signed-in person, in their dashboard language", async () => {
    const response = await POST(cancelRequest({ confirmName: "Studio", userId: "owner", businessId: "business_3" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: "owner@example.test", expiresAt: "2026-10-31T15:11:00.000Z" });
    expect(fixture.request).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", confirmName: "Studio", locale: "fr" });
    expect(fixture.log).toHaveBeenCalledWith("info", "business.cancellation_requested", { businessId: "business_1", userId: "user_1" });
    expect(fixture.log).toHaveBeenCalledTimes(1);
  });

  it("leaves the language out when the person's isn't one the dashboard has", async () => {
    fixture.locale.mockResolvedValue([{ locale: "de-DE" }]);
    await POST(cancelRequest({ confirmName: "Studio" }));
    expect(fixture.request).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", confirmName: "Studio", locale: undefined });
  });

  it("warns when the deployment has no inbox to tell", async () => {
    fixture.request.mockResolvedValue({ email: "owner@example.test", expiresAt, inboxNotified: false });
    const response = await POST(cancelRequest({ confirmName: "Studio" }));
    expect(response.status).toBe(200);
    expect(fixture.log).toHaveBeenCalledWith("warn", "business.cancellation_inbox_missing", expect.objectContaining({ businessId: "business_1" }));
  });

  it("counts every try against the person, 5 an hour, since each sends two emails", async () => {
    await POST(cancelRequest({ confirmName: "Studio" }));
    expect(fixture.enforce).toHaveBeenCalledWith([expect.objectContaining({ name: "user-hour", limit: 5, windowSeconds: 3_600, reason: "rate_limit_user_hour", key: expect.stringContaining(":business-cancel-request:user-hour:") })]);
  });

  it.each([
    ["no business", { confirmName: "Studio" }, "", "business_required"],
    ["no typed name", {}, "?businessId=business_1", "confirmation_required"],
    ["a blank typed name", { confirmName: "  " }, "?businessId=business_1", "confirmation_required"],
    ["a typed name that isn't text", { confirmName: ["Studio"] }, "?businessId=business_1", "confirmation_required"],
  ])("refuses a request with %s before counting it", async (_case, body, query, code) => {
    const response = await POST(cancelRequest(body, query));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code });
    expect(fixture.enforce).not.toHaveBeenCalled();
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("stops at the limit without sending anything", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-30T15:45:00Z") });
    fixture.enforce.mockResolvedValue({ allowed: false, status: 429, reason: "rate_limit_user_hour" });
    const response = await POST(cancelRequest({ confirmName: "Studio" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("900");
    expect(await response.json()).toEqual({ error: "Too many tries. Try again later.", code: "rate_limited" });
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("refuses for a moment when the limit can't be counted", async () => {
    fixture.enforce.mockResolvedValue({ allowed: false, status: 503, reason: "rate_limit_unavailable" });
    const response = await POST(cancelRequest({ confirmName: "Studio" }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toMatchObject({ code: "rate_limit_unavailable" });
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it.each([
    ["other_businesses", 403, "You own other businesses. Delete them first, then cancel this one."],
    ["forbidden", 403, "Only an owner of the business can cancel it."],
    ["confirmation_mismatch", 400, "Type the business's name exactly as it's shown to confirm."],
  ])("answers a %s refusal with its status and message", async (code, status, message) => {
    fixture.request.mockRejectedValue(refusal(code, status, message));
    const response = await POST(cancelRequest({ confirmName: "Studio" }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message, code });
    expect(fixture.log).not.toHaveBeenCalled();
  });
});

describe("the cancellation link's preview", () => {
  it("looks the link up by its token's hash, never the token", async () => {
    const cancellation = { businessName: "Studio", email: "owner@example.test", expiresAt: expiresAt.toISOString(), state: "pending" };
    fixture.preview.mockResolvedValue(cancellation);
    const response = await GET(new Request("http://localhost:3000/api/businesses/cancellation?token=%20secret-token%20"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancellation });
    expect(fixture.preview).toHaveBeenCalledWith({ db: "app" }, { tokenHash: createHash("sha256").update("secret-token").digest("hex") });
  });

  it("answers no cancellation for a link without a token, or one that matches none", async () => {
    expect(await (await GET(new Request("http://localhost:3000/api/businesses/cancellation"))).json()).toEqual({ cancellation: null });
    expect(fixture.preview).not.toHaveBeenCalled();
    fixture.preview.mockResolvedValue(null);
    expect(await (await GET(new Request("http://localhost:3000/api/businesses/cancellation?token=unknown"))).json()).toEqual({ cancellation: null });
  });
});
