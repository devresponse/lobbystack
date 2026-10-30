import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ update: vi.fn(), remove: vi.fn(), verify: vi.fn(), enforce: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  requireApiSession: async () => ({ user: { id: "user_1" } }),
  requireOperatorBusiness: async () => ({ session: { user: { id: "user_1" } }, businessId: "business_1" }),
}));
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { verifyPassword: fixture.verify } }) }));
vi.mock("@/lib/fixed-window-limit", async (original) => ({ ...await original<typeof import("@/lib/fixed-window-limit")>(), enforceFixedWindow: fixture.enforce }));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: "app" }) }));
vi.mock("@lobbystack/domain", () => ({ updateBusiness: fixture.update, deleteBusiness: fixture.remove }));
vi.mock("@lobbystack/telemetry/node", async (original) => ({ ...await original<typeof import("@lobbystack/telemetry/node")>(), logEvent: fixture.log }));

import { DELETE, PATCH } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.enforce.mockResolvedValue({ allowed: true });
  fixture.verify.mockResolvedValue({ status: true });
  fixture.remove.mockResolvedValue({ releasedNumbers: 1, storedFiles: 3 });
});
afterEach(() => { vi.useRealTimers(); });

describe("business settings API", () => {
  it("acts as the signed-in operator even when the body names another user or business", async () => {
    const response = await PATCH(new Request("http://localhost:3000/api/businesses?businessId=business_1", {
      method: "PATCH",
      body: JSON.stringify({ userId: "owner", businessId: "business_2", timezone: "Asia/Tokyo" }),
    }));
    expect(response.status).toBe(200);
    expect(fixture.update).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", timezone: "Asia/Tokyo" });
  });
});

function deleteRequest(body: unknown, query = "?businessId=business_2") {
  return new Request(`http://localhost:3000/api/businesses${query}`, { method: "DELETE", body: JSON.stringify(body) });
}

function refusal(code: string, status: number, message: string) {
  return Object.assign(new Error(message), { status, code });
}

describe("deleting a business through the API", () => {
  it("deletes the business the query names, as the signed-in person, once the typed name and password check out", async () => {
    const request = deleteRequest({ confirmName: "Studio", password: "correct horse", userId: "owner", businessId: "business_3" });
    const response = await DELETE(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fixture.verify).toHaveBeenCalledWith({ body: { password: "correct horse" }, headers: request.headers });
    expect(fixture.remove).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_2", confirmName: "Studio" });
    // The audit log goes with the business, so the log line records who deleted it.
    expect(fixture.log).toHaveBeenCalledWith("info", "business.deleted", { businessId: "business_2", userId: "user_1", releasedNumbers: 1, storedFiles: 3 });
  });

  it("counts every try against the person, 10 an hour", async () => {
    await DELETE(deleteRequest({ confirmName: "Studio", password: "correct horse" }));
    expect(fixture.enforce).toHaveBeenCalledWith([expect.objectContaining({ name: "user-hour", limit: 10, windowSeconds: 3_600, reason: "rate_limit_user_hour", key: expect.stringContaining(":business-delete:user-hour:") })]);
  });

  it.each([
    ["no business", { confirmName: "Studio", password: "correct horse" }, "", "business_required"],
    ["no typed name", { password: "correct horse" }, "?businessId=business_2", "confirmation_required"],
    ["a blank typed name", { confirmName: "   ", password: "correct horse" }, "?businessId=business_2", "confirmation_required"],
    ["a typed name that isn't text", { confirmName: ["Studio"], password: "correct horse" }, "?businessId=business_2", "confirmation_required"],
    ["no password", { confirmName: "Studio" }, "?businessId=business_2", "password_required"],
    ["an empty password", { confirmName: "Studio", password: "" }, "?businessId=business_2", "password_required"],
  ])("refuses a request with %s before checking anything else", async (_case, body, query, code) => {
    const response = await DELETE(deleteRequest(body, query));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code });
    expect(fixture.enforce).not.toHaveBeenCalled();
    expect(fixture.verify).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it.each([
    ["a wrong password", "INVALID_PASSWORD"],
    ["a password longer than sign-up allows", "PASSWORD_TOO_LONG"],
  ])("refuses %s without deleting", async (_case, code) => {
    fixture.verify.mockRejectedValue(Object.assign(new Error("Refused"), { body: { code } }));
    const response = await DELETE(deleteRequest({ confirmName: "Studio", password: "wrong" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That password isn't right.", code: "invalid_password" });
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(fixture.log).not.toHaveBeenCalled();
  });

  it("fails without deleting when the password can't be checked", async () => {
    fixture.verify.mockRejectedValue(new Error("Session expired"));
    const response = await DELETE(deleteRequest({ confirmName: "Studio", password: "correct horse" }));
    expect(response.status).toBe(500);
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it("stops at the limit before checking the password, so the dialog can't be used to guess it", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-30T08:45:00Z") });
    fixture.enforce.mockResolvedValue({ allowed: false, status: 429, reason: "rate_limit_user_hour" });
    const response = await DELETE(deleteRequest({ confirmName: "Studio", password: "guess" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("900");
    expect(await response.json()).toEqual({ error: "Too many tries. Try again later.", code: "rate_limited" });
    expect(fixture.verify).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it("refuses for a moment when the limit can't be counted", async () => {
    fixture.enforce.mockResolvedValue({ allowed: false, status: 503, reason: "rate_limit_unavailable" });
    const response = await DELETE(deleteRequest({ confirmName: "Studio", password: "correct horse" }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toMatchObject({ code: "rate_limit_unavailable" });
    expect(fixture.verify).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it.each([
    ["root_business", 403, "This is the first business on your account, so it can't be deleted."],
    ["only_business", 403, "This is the only business your account owns, so it can't be deleted."],
    ["forbidden", 403, "Only an owner of the business can delete it."],
    ["confirmation_mismatch", 400, "Type the business's name exactly as it's shown to confirm."],
    ["call_in_progress", 409, "A call is in progress on this business. Try again when it ends."],
  ])("answers a %s refusal with its status and message, once", async (code, status, message) => {
    fixture.remove.mockRejectedValue(refusal(code, status, message));
    const response = await DELETE(deleteRequest({ confirmName: "Studio", password: "correct horse" }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message, code });
    expect(fixture.remove).toHaveBeenCalledTimes(1);
    expect(fixture.log).not.toHaveBeenCalled();
  });

  it("asks again every 2 seconds while the worker ends the paid plan, then deletes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    fixture.remove
      .mockRejectedValueOnce(refusal("plan_ending", 409, "The business's paid plan is being canceled. Try again in a few seconds."))
      .mockRejectedValueOnce(refusal("plan_ending", 409, "The business's paid plan is being canceled. Try again in a few seconds."))
      .mockResolvedValueOnce({ releasedNumbers: 0, storedFiles: 0 });
    const pending = DELETE(deleteRequest({ confirmName: "Studio", password: "correct horse" }));
    await vi.runAllTimersAsync();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(fixture.remove).toHaveBeenCalledTimes(3);
    // The password is checked once, not on every try.
    expect(fixture.verify).toHaveBeenCalledTimes(1);
    expect(fixture.log).toHaveBeenCalledTimes(1);
  });

  it("answers plan_ending after 20 seconds if the plan still hasn't ended", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const started = Date.now();
    fixture.remove.mockRejectedValue(refusal("plan_ending", 409, "The business's paid plan is being canceled. Try again in a few seconds."));
    const pending = DELETE(deleteRequest({ confirmName: "Studio", password: "correct horse" }));
    await vi.runAllTimersAsync();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "plan_ending" });
    // Tries at 0, 2, 4 ... 20 seconds.
    expect(fixture.remove).toHaveBeenCalledTimes(11);
    expect(Date.now() - started).toBe(20_000);
    expect(fixture.log).not.toHaveBeenCalled();
  });
});
