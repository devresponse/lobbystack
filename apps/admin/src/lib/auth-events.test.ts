import { APIError } from "better-auth/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ log: vi.fn(), report: vi.fn(), account: vi.fn() }));
vi.mock("@lobbystack/telemetry/node", async (original) => ({ ...await original<typeof import("@lobbystack/telemetry/node")>(), logEvent: mocks.log }));
vi.mock("./error-reporting", () => ({ reportServerError: mocks.report }));
vi.mock("./databases", () => ({ getDatabase: () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.account }) }) }) } }) }));

import { betterAuthLogger, logAuthOutcome, logAuthRateLimit, logRefusals } from "./auth-events";

const headers = () => new Headers({ "x-real-ip": "203.0.113.10" });

/** An emailed verification link's token: only its claims matter here. */
function linkToken(claims: Record<string, string>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "x-real-ip");
  mocks.account.mockResolvedValue([{ id: "user-1" }]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("sign-in lines", () => {
  it("logs a wrong password for the account that has the address, without the address or the password", async () => {
    await logAuthOutcome({
      path: "/sign-in/email",
      body: { email: "Owner@Example.test", password: "not-my-password" },
      headers: headers(),
      context: { returned: APIError.from("UNAUTHORIZED", { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }) },
    });

    expect(mocks.log).toHaveBeenCalledExactlyOnceWith("warn", "auth.sign_in_failed", {
      path: "/sign-in/email", userId: "user-1", accountFound: true, status: 401, code: "INVALID_EMAIL_OR_PASSWORD", ip: "203.0.113.10",
    });
    expect(JSON.stringify(mocks.log.mock.calls)).not.toMatch(/owner@example\.test|not-my-password/i);
  });

  it("says no account has the address when nobody does", async () => {
    mocks.account.mockResolvedValue([]);
    await logAuthOutcome({
      path: "/sign-in/email",
      body: { email: "nobody@example.test", password: "x" },
      context: { returned: APIError.from("UNAUTHORIZED", { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }) },
    });

    expect(mocks.log).toHaveBeenCalledWith("warn", "auth.sign_in_failed", expect.objectContaining({ accountFound: false, code: "INVALID_EMAIL_OR_PASSWORD" }));
  });

  it("logs a sign-in with its account and session, without looking the account up", async () => {
    await logAuthOutcome({
      path: "/sign-in/email",
      body: { email: "owner@example.test", password: "secret-password" },
      headers: headers(),
      context: { returned: { token: "session-token" }, newSession: { session: { id: "session-1" }, user: { id: "user-1" } } },
    });

    expect(mocks.log).toHaveBeenCalledExactlyOnceWith("info", "auth.signed_in", { path: "/sign-in/email", userId: "user-1", authSessionId: "session-1", ip: "203.0.113.10" });
    expect(mocks.account).not.toHaveBeenCalled();
  });

  it("still logs a failed sign-in when the account lookup fails, and never throws", async () => {
    mocks.account.mockRejectedValue(new Error("database offline"));
    await expect(logAuthOutcome({
      path: "/sign-in/email",
      body: { email: "owner@example.test" },
      context: { returned: APIError.from("FORBIDDEN", { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" }) },
    })).resolves.toBeUndefined();

    expect(mocks.log).toHaveBeenCalledExactlyOnceWith("warn", "auth.sign_in_failed", { path: "/sign-in/email", status: 403, code: "EMAIL_NOT_VERIFIED" });
  });

  it("leaves routes it doesn't name alone", async () => {
    await logAuthOutcome({ path: "/get-session", context: { returned: null } });
    expect(mocks.log).not.toHaveBeenCalled();
  });
});

describe("password and email lines", () => {
  it("logs a password change for the signed-in account and whether other sessions ended", async () => {
    const session = { user: { id: "user-1" } };
    await logAuthOutcome({ path: "/change-password", body: { revokeOtherSessions: true }, context: { returned: { token: null }, session } });
    await logAuthOutcome({ path: "/change-password", body: {}, context: { returned: APIError.from("BAD_REQUEST", { code: "INVALID_PASSWORD", message: "Invalid password" }), session } });

    expect(mocks.log.mock.calls).toEqual([
      ["info", "auth.password_changed", { path: "/change-password", userId: "user-1", revokedOtherSessions: true }],
      ["warn", "auth.password_change_failed", { path: "/change-password", userId: "user-1", status: 400, code: "INVALID_PASSWORD" }],
    ]);
  });

  it("logs a reset code that ran out of tries, for the account it was sent to", async () => {
    await logAuthOutcome({
      path: "/email-otp/reset-password",
      body: { email: "owner@example.test", otp: "123456", password: "New-password-1" },
      context: { returned: APIError.from("FORBIDDEN", { code: "TOO_MANY_ATTEMPTS", message: "Too many attempts" }) },
    });

    expect(mocks.log).toHaveBeenCalledExactlyOnceWith("warn", "auth.password_reset_failed", {
      path: "/email-otp/reset-password", method: "code", userId: "user-1", accountFound: true, status: 403, code: "TOO_MANY_ATTEMPTS",
    });
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("123456");
  });

  it("names each email-change step by the link's claims, never logging the token", async () => {
    const token = linkToken({ email: "old@example.test", updateTo: "new@example.test", requestType: "change-email-confirmation" });
    await logAuthOutcome({ path: "/verify-email", query: { token }, context: { returned: { status: true } } });
    await logAuthOutcome({
      path: "/verify-email",
      query: { token: linkToken({ email: "old@example.test", updateTo: "new@example.test", requestType: "change-email-verification" }) },
      context: { returned: { status: true }, newSession: { session: { id: "session-2" }, user: { id: "user-1" } } },
    });
    await logAuthOutcome({ path: "/verify-email", query: { token: linkToken({ email: "owner@example.test" }) }, context: { returned: { status: true } } });

    expect(mocks.log.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ["auth.email_change_confirmed", { path: "/verify-email", method: "link", userId: "user-1", emailChange: true }],
      ["auth.email_changed", { path: "/verify-email", method: "link", userId: "user-1", emailChange: true }],
      ["auth.email_verified", { path: "/verify-email", method: "link", userId: "user-1" }],
    ]);
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(token);
  });

  it("reads a failed link's code from the redirect that carries it", async () => {
    const redirect = new APIError("FOUND", undefined, new Headers({ location: "https://app.example.test/en/verify-email?error=TOKEN_EXPIRED" }));
    await logAuthOutcome({ path: "/verify-email", query: { token: "expired" }, context: { returned: redirect } });
    await logAuthOutcome({ path: "/verify-email", query: { token: linkToken({ email: "owner@example.test" }) }, context: { returned: new APIError("FOUND", undefined, new Headers({ location: "/settings/account" })) } });

    expect(mocks.log.mock.calls.map((call) => [call[0], call[1], call[2].code])).toEqual([
      ["warn", "auth.email_verification_failed", "TOKEN_EXPIRED"],
      ["info", "auth.email_verified", undefined],
    ]);
  });

  it("logs a wrong verification code for the account it was sent to", async () => {
    await logAuthOutcome({
      path: "/email-otp/verify-email",
      body: { email: "owner@example.test", otp: "000000" },
      context: { returned: APIError.from("BAD_REQUEST", { code: "INVALID_OTP", message: "Invalid OTP" }) },
    });

    expect(mocks.log).toHaveBeenCalledExactlyOnceWith("warn", "auth.email_verification_failed", {
      path: "/email-otp/verify-email", method: "code", userId: "user-1", accountFound: true, status: 400, code: "INVALID_OTP",
    });
  });
});

describe("refusals before Better Auth runs", () => {
  it("logs a refused sign-up with its message when it has no code, and still refuses", async () => {
    const refusal = new APIError("BAD_REQUEST", { message: "Turnstile verification failed." });
    await expect(logRefusals({ path: "/sign-up/email", headers: headers(), context: {} }, async () => { throw refusal; })).rejects.toBe(refusal);

    expect(mocks.log).toHaveBeenCalledExactlyOnceWith("warn", "auth.sign_up_failed", {
      path: "/sign-up/email", status: 400, code: "BAD_REQUEST", detail: "Turnstile verification failed.", ip: "203.0.113.10",
    });
  });

  it("leaves outages and unnamed routes to error tracking", async () => {
    await expect(logRefusals({ path: "/sign-in/email", context: {} }, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    await expect(logRefusals({ path: "/email-otp/send-verification-otp", context: {} }, async () => { throw new APIError("NOT_FOUND", { message: "Endpoint not enabled." }); })).rejects.toThrow();
    await expect(logRefusals({ path: "/sign-in/email", context: {} }, async () => "allowed")).resolves.toBe("allowed");

    expect(mocks.log).not.toHaveBeenCalled();
  });
});

describe("lockouts", () => {
  const limited = () => new Response(JSON.stringify({ message: "Too many requests. Please try again later." }), { status: 429, headers: { "X-Retry-After": "42" } });

  it("logs Better Auth's rate limit once a minute for each route and address", () => {
    vi.useFakeTimers();
    const request = () => new Request("https://app.example.test/api/auth/sign-in/email", { method: "POST", headers: { "x-real-ip": "198.51.100.7" } });
    logAuthRateLimit(request(), limited());
    logAuthRateLimit(request(), limited());
    vi.advanceTimersByTime(61_000);
    logAuthRateLimit(request(), limited());

    expect(mocks.log.mock.calls).toEqual([
      ["warn", "auth.rate_limited", { path: "/sign-in/email", limit: "route", ip: "198.51.100.7", retryAfter: 42 }],
      ["warn", "auth.rate_limited", { path: "/sign-in/email", limit: "route", ip: "198.51.100.7", retryAfter: 42 }],
    ]);
  });

  it("ignores answers that aren't the rate limit", () => {
    const request = new Request("https://app.example.test/api/auth/sign-up/email", { method: "POST" });
    logAuthRateLimit(request, Response.json({}, { status: 429 }));
    logAuthRateLimit(request, Response.json({}, { status: 200 }));

    expect(mocks.log).not.toHaveBeenCalled();
  });
});

describe("Better Auth's own log", () => {
  it("sends its exceptions to error tracking and prints its other errors and warnings as lines", () => {
    const failure = new Error("connect ECONNREFUSED");
    betterAuthLogger.log("error", "Error", failure);
    betterAuthLogger.log("error", "Invalid origin: https://elsewhere.example");
    betterAuthLogger.log("warn", "User not found", { email: "owner@example.test" });
    betterAuthLogger.log("warn", "Rate limiting could not determine a client IP");
    betterAuthLogger.log("info", "Ready");

    expect(mocks.report).toHaveBeenCalledExactlyOnceWith(failure, { operation: "auth.better_auth", detail: "Error" });
    expect(mocks.log.mock.calls).toEqual([
      ["error", "auth.better_auth_error", { error: "Invalid origin: https://elsewhere.example" }],
      ["warn", "auth.better_auth_warning", { error: "Rate limiting could not determine a client IP" }],
    ]);
  });
});
