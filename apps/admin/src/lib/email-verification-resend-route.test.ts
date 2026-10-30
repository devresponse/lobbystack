import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RateLimitError extends Error {}
  return {
    RateLimitError,
    assertAllowed: vi.fn(),
    issueCode: vi.fn(),
    verifyTurnstile: vi.fn(),
    log: vi.fn(),
    report: vi.fn(),
  };
});

vi.mock("@/lib/email-verification-policy", () => ({
  assertEmailVerificationSendAllowed: mocks.assertAllowed,
  EmailVerificationRateLimitError: mocks.RateLimitError,
}));
vi.mock("@/lib/auth", () => ({ issueEmailVerificationCode: mocks.issueCode }));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: mocks.verifyTurnstile }));
vi.mock("@/lib/error-reporting", () => ({ reportServerError: mocks.report }));
vi.mock("@lobbystack/telemetry/node", async (original) => ({ ...await original<typeof import("@lobbystack/telemetry/node")>(), logEvent: mocks.log }));

import { POST } from "../../app/api/auth/email-otp/send-verification-otp/route";
import { attachVerificationFlow } from "./verification-flow";

function resendRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://app.example.test/api/auth/email-otp/send-verification-otp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "x-real-ip");
  mocks.assertAllowed.mockResolvedValue(undefined);
  mocks.issueCode.mockResolvedValue(true);
  mocks.verifyTurnstile.mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("email verification resend route", () => {
  it("reuses signup proof without another challenge or extending its lifetime", async () => {
    vi.stubEnv("APP_BASE_URL", "https://app.example.test");
    const signup = new Response();
    attachVerificationFlow(signup, "owner@example.invalid");
    const headers = { origin: "https://app.example.test", cookie: signup.headers.get("set-cookie")!.split(";")[0]! };
    const response = await POST(resendRequest({ email: "owner@example.invalid", type: "email-verification" }, headers));
    expect(response.status).toBe(200);
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
    expect(mocks.issueCode).toHaveBeenCalledOnce();
    expect(response.headers.get("set-cookie")).toBeNull();
    mocks.issueCode.mockRejectedValueOnce(new mocks.RateLimitError());
    const limited = await POST(resendRequest({ email: "owner@example.invalid", type: "email-verification" }, headers));
    expect(limited.status).toBe(429);
  });
  it("requires a valid request and Turnstile challenge", async () => {
    const invalid = await POST(resendRequest({ email: "not-an-email", type: "email-verification" }));
    expect(invalid.status).toBe(400);
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();

    mocks.verifyTurnstile.mockRejectedValueOnce(new Error("failed"));
    const challenged = await POST(resendRequest({ email: "owner@example.invalid", type: "email-verification", turnstileToken: "invalid" }));
    expect(challenged.status).toBe(400);
    expect(mocks.issueCode).not.toHaveBeenCalled();
  });

  it("checks the challenge and recipient limit before issuing a code", async () => {
    const response = await POST(resendRequest(
      { email: "Owner@Example.invalid", type: "email-verification", turnstileToken: "challenge" },
      { "x-real-ip": "203.0.113.10" },
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(mocks.verifyTurnstile).toHaveBeenCalledWith({ token: "challenge", remoteIp: "203.0.113.10" });
    expect(mocks.assertAllowed).not.toHaveBeenCalled();
    expect(mocks.issueCode).toHaveBeenCalledWith("owner@example.invalid", "203.0.113.10");
  });

  it("prefers Railway's trusted client IP header", async () => {
    await POST(resendRequest(
      { email: "owner@example.invalid", type: "email-verification", turnstileToken: "challenge" },
      { "x-real-ip": "203.0.113.10", "cf-connecting-ip": "198.51.100.20" },
    ));
    expect(mocks.verifyTurnstile).toHaveBeenCalledWith({ token: "challenge", remoteIp: "203.0.113.10" });
    expect(mocks.issueCode).toHaveBeenCalledWith("owner@example.invalid", "203.0.113.10");
  });

  it("omits the remote IP when no trusted header is configured", async () => {
    vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "");
    const response = await POST(resendRequest(
      { email: "owner@example.invalid", type: "email-verification", turnstileToken: "challenge" },
      { "x-real-ip": "203.0.113.10" },
    ));
    expect(response.status).toBe(200);
    expect(mocks.verifyTurnstile).toHaveBeenCalledWith({ token: "challenge" });
    expect(mocks.issueCode).toHaveBeenCalledWith("owner@example.invalid", undefined);
  });

  it("returns the same success response when no unverified recipient exists", async () => {
    mocks.issueCode.mockResolvedValueOnce(false);
    const response = await POST(resendRequest({ email: "missing@example.invalid", type: "email-verification", turnstileToken: "challenge" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
  });

  it("logs each refused request and the recipient cooldown, without the address", async () => {
    const ip = { "x-real-ip": "203.0.113.99" };
    await POST(resendRequest({ email: "not-an-email", type: "email-verification" }, ip));
    mocks.verifyTurnstile.mockRejectedValueOnce(new Error("failed"));
    await POST(resendRequest({ email: "owner@example.invalid", type: "email-verification", turnstileToken: "invalid" }, ip));
    mocks.issueCode.mockRejectedValueOnce(new mocks.RateLimitError());
    await POST(resendRequest({ email: "owner@example.invalid", type: "email-verification", turnstileToken: "challenge" }, ip));

    const path = "/email-otp/send-verification-otp";
    expect(mocks.log.mock.calls).toEqual([
      ["warn", "auth.verification_code_request_failed", { path, status: 400, code: "INVALID_REQUEST", ip: "203.0.113.99" }],
      ["warn", "auth.verification_code_request_failed", { path, status: 400, code: "CHALLENGE_FAILED", ip: "203.0.113.99" }],
      ["warn", "auth.rate_limited", { path, limit: "recipient", ip: "203.0.113.99" }],
    ]);
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("owner@example.invalid");
  });

  it("reports an outage with the Error ID it answers with", async () => {
    const outage = new Error("connect ECONNREFUSED");
    mocks.issueCode.mockRejectedValueOnce(outage);
    const response = await POST(resendRequest({ email: "owner@example.invalid", type: "email-verification", turnstileToken: "challenge" }));

    expect(response.status).toBe(503);
    const body = await response.json() as { code: string; errorId: string };
    expect(body).toEqual({ code: "SERVICE_UNAVAILABLE", message: "Verification service unavailable.", errorId: expect.any(String) });
    expect(response.headers.get("x-error-id")).toBe(body.errorId);
    expect(mocks.report).toHaveBeenCalledExactlyOnceWith(outage, { operation: "auth.verification_code", errorId: body.errorId, route: "/api/auth/email-otp/send-verification-otp" });
  });

  it("returns a generic recipient cooldown without issuing a code", async () => {
    mocks.issueCode.mockRejectedValueOnce(new mocks.RateLimitError());
    const response = await POST(resendRequest({ email: "owner@example.invalid", type: "email-verification", turnstileToken: "challenge" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(mocks.issueCode).toHaveBeenCalledTimes(1);
  });
});
