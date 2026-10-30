import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ confirm: vi.fn(), verify: vi.fn(), enforce: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  requireApiSession: async () => ({ user: { id: "user_1" } }),
}));
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { verifyPassword: fixture.verify } }) }));
vi.mock("@/lib/fixed-window-limit", async (original) => ({ ...await original<typeof import("@/lib/fixed-window-limit")>(), enforceFixedWindow: fixture.enforce }));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: "app" }) }));
vi.mock("@lobbystack/domain", () => ({ confirmBusinessCancellation: fixture.confirm }));
vi.mock("@lobbystack/telemetry/node", async (original) => ({ ...await original<typeof import("@lobbystack/telemetry/node")>(), logEvent: fixture.log }));

import { POST } from "./route";

const tokenHash = createHash("sha256").update("secret-token").digest("hex");

beforeEach(() => {
  vi.clearAllMocks();
  fixture.enforce.mockResolvedValue({ allowed: true });
  fixture.verify.mockResolvedValue({ status: true });
  fixture.confirm.mockResolvedValue({ businessId: "business_1", businessName: "Studio", numbersReleasedOn: new Date("2026-11-29T16:02:00.000Z"), endsPlan: true });
});
afterEach(() => { vi.useRealTimers(); });

function confirmRequest(body: unknown) {
  return new Request("http://localhost:3000/api/businesses/cancellation/confirm", { method: "POST", body: JSON.stringify(body) });
}

function refusal(code: string, status: number, message: string) {
  return Object.assign(new Error(message), { status, code });
}

describe("confirming a business cancellation through the API", () => {
  it("cancels the business the link names, as the signed-in person, once the password checks out", async () => {
    const request = confirmRequest({ token: " secret-token ", password: "correct horse", userId: "owner", businessId: "business_3" });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, businessName: "Studio" });
    expect(fixture.verify).toHaveBeenCalledWith({ body: { password: "correct horse" }, headers: request.headers });
    expect(fixture.confirm).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", tokenHash });
    expect(fixture.log).toHaveBeenCalledWith("info", "business.canceled", { businessId: "business_1", userId: "user_1", endsPlan: true, numbersReleasedOn: "2026-11-29T16:02:00.000Z" });
  });

  it("logs no release date for a business without numbers", async () => {
    fixture.confirm.mockResolvedValue({ businessId: "business_1", businessName: "Studio", numbersReleasedOn: null, endsPlan: false });
    await POST(confirmRequest({ token: "secret-token", password: "correct horse" }));
    expect(fixture.log).toHaveBeenCalledWith("info", "business.canceled", { businessId: "business_1", userId: "user_1", endsPlan: false, numbersReleasedOn: null });
  });

  it("counts every try against the person, 10 an hour", async () => {
    await POST(confirmRequest({ token: "secret-token", password: "correct horse" }));
    expect(fixture.enforce).toHaveBeenCalledWith([expect.objectContaining({ name: "user-hour", limit: 10, windowSeconds: 3_600, reason: "rate_limit_user_hour", key: expect.stringContaining(":business-cancel:user-hour:") })]);
  });

  it.each([
    ["no token", { password: "correct horse" }, "token_required"],
    ["a blank token", { token: "  ", password: "correct horse" }, "token_required"],
    ["no password", { token: "secret-token" }, "password_required"],
    ["an empty password", { token: "secret-token", password: "" }, "password_required"],
  ])("refuses a request with %s before checking anything else", async (_case, body, code) => {
    const response = await POST(confirmRequest(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code });
    expect(fixture.enforce).not.toHaveBeenCalled();
    expect(fixture.verify).not.toHaveBeenCalled();
    expect(fixture.confirm).not.toHaveBeenCalled();
  });

  it("refuses a wrong password without canceling", async () => {
    fixture.verify.mockRejectedValue(Object.assign(new Error("Refused"), { body: { code: "INVALID_PASSWORD" } }));
    const response = await POST(confirmRequest({ token: "secret-token", password: "wrong" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That password isn't right.", code: "invalid_password" });
    expect(fixture.confirm).not.toHaveBeenCalled();
    expect(fixture.log).not.toHaveBeenCalled();
  });

  it("stops at the limit before checking the password, so the page can't be used to guess it", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-30T16:30:00Z") });
    fixture.enforce.mockResolvedValue({ allowed: false, status: 429, reason: "rate_limit_user_hour" });
    const response = await POST(confirmRequest({ token: "secret-token", password: "guess" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1800");
    expect(await response.json()).toEqual({ error: "Too many tries. Try again later.", code: "rate_limited" });
    expect(fixture.verify).not.toHaveBeenCalled();
    expect(fixture.confirm).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong_account", 403, "Sign in as the owner who asked to cancel the business."],
    ["other_businesses", 403, "You own other businesses. Delete them first, then cancel this one."],
    ["expired", 410, "This cancellation link has expired. Ask for a new one on the business's Team page."],
    ["already_canceled", 409, "This business is already canceled."],
    ["call_in_progress", 409, "A call is in progress on this business. Try again when it ends."],
  ])("answers a %s refusal with its status and message", async (code, status, message) => {
    fixture.confirm.mockRejectedValue(refusal(code, status, message));
    const response = await POST(confirmRequest({ token: "secret-token", password: "correct horse" }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message, code });
    expect(fixture.log).not.toHaveBeenCalled();
  });
});
