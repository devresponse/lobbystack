import { afterEach, describe, expect, it, vi } from "vitest";

import { trustedClientIp, trustedClientIpFromHeaders, trustedClientIpHeader, trustedClientIpStartupError } from "./trusted-client-ip";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

const request = (headers: Record<string, string>) => new Request("https://admin.test/api", { headers });

describe("trusted client IP derivation", () => {
  it("trusts nothing without an explicit deployment opt-in", () => {
    vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "");
    expect(trustedClientIpHeader()).toBeUndefined();
    expect(trustedClientIp(request({ "x-forwarded-for": "203.0.113.1", "x-real-ip": "203.0.113.2", "cf-connecting-ip": "198.51.100.3" }))).toBeUndefined();
  });

  it("accepts only the configured, ingress-controlled header", () => {
    vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "x-real-ip");
    expect(trustedClientIpHeader()).toBe("x-real-ip");
    expect(trustedClientIp(request({ "x-real-ip": "203.0.113.2", "x-forwarded-for": "10.0.0.1" }))).toBe("203.0.113.2");
    expect(trustedClientIp(request({ "cf-connecting-ip": "198.51.100.3" }))).toBeUndefined();
  });

  it("is case-insensitive about the configured header and rejects invalid values", () => {
    vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "CF-Connecting-IP");
    expect(trustedClientIpHeader()).toBe("cf-connecting-ip");
    expect(trustedClientIp(request({ "cf-connecting-ip": "198.51.100.3" }))).toBe("198.51.100.3");
    expect(trustedClientIp(request({ "cf-connecting-ip": "203.0.113.1, 203.0.113.2" }))).toBeUndefined();
    expect(trustedClientIp(request({ "cf-connecting-ip": "not-an-ip" }))).toBeUndefined();
    expect(trustedClientIp(request({ "cf-connecting-ip": "" }))).toBeUndefined();
  });

  it("rejects forwarded-for and unknown opt-ins", () => {
    vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "x-forwarded-for");
    expect(trustedClientIpHeader()).toBeUndefined();
    expect(trustedClientIp(request({ "x-forwarded-for": "203.0.113.1" }))).toBeUndefined();
  });

  it("reads from bare headers for the auth middleware context", () => {
    vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "x-real-ip");
    expect(trustedClientIpFromHeaders(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("warns once in production when the opt-in is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const clientIp = await import("./trusted-client-ip");
    expect(clientIp.trustedClientIp(request({ "x-real-ip": "203.0.113.2" }))).toBeUndefined();
    expect(clientIp.trustedClientIp(request({ "x-real-ip": "203.0.113.2" }))).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("TRUSTED_CLIENT_IP_HEADER");
  });
});

// AUDIT-004: on Railway the limits per IP address always run, so a production admin there won't start without the header.
describe("the trusted header on Railway", () => {
  const railway = { NODE_ENV: "production", RAILWAY_PROJECT_ID: "project", RAILWAY_ENVIRONMENT_ID: "environment", RAILWAY_SERVICE_ID: "service" };

  it("refuses a production start on Railway without the header, and says which to set", () => {
    const error = trustedClientIpStartupError(railway);
    expect(error).toContain("TRUSTED_CLIENT_IP_HEADER is not set");
    expect(error).toContain("x-real-ip");
    expect(error).toContain("cf-connecting-ip");
  });

  it("names a value it doesn't accept", () => {
    expect(trustedClientIpStartupError({ ...railway, TRUSTED_CLIENT_IP_HEADER: "x-forwarded-for" })).toContain('TRUSTED_CLIENT_IP_HEADER is "x-forwarded-for"');
  });

  it.each(["RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID"])("knows Railway by %s alone", (name) => {
    expect(trustedClientIpStartupError({ NODE_ENV: "production", [name]: "set" })).not.toBeNull();
  });

  it.each(["x-real-ip", "cf-connecting-ip", " X-Real-IP "])("starts with %s", (header) => {
    expect(trustedClientIpStartupError({ ...railway, TRUSTED_CLIENT_IP_HEADER: header })).toBeNull();
  });

  it.each([
    ["off Railway, where the proxy in front is unknown", { NODE_ENV: "production" }],
    ["outside production", { ...railway, NODE_ENV: "development" }],
    ["during a build, which serves no one", { ...railway, NEXT_PHASE: "phase-production-build" }],
    ["with Railway's variables blank", { NODE_ENV: "production", RAILWAY_PROJECT_ID: " " }],
  ])("lets the admin start %s", (_label, env) => {
    expect(trustedClientIpStartupError(env)).toBeNull();
  });
});
