import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import {
  ACCESS_COOKIE_MAX_AGE_SECONDS,
  accessCookieIsValid,
  accessCookieName,
  accessCookieValue,
  accessDeniedResponse,
  accessGrantedResponse,
  decideAccess,
  isOpenRoute,
  protectionToken,
  protectionTokenStartupError,
} from "./access-gate";

const TOKEN = "protection-token-fixture-0123456789-abcdef";
const OTHER_TOKEN = "another-protection-token-fixture-9876543210";
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const on = { PROTECTION_TOKEN: TOKEN };

function request(path: string, init: { method?: string; headers?: Record<string, string>; origin?: string } = {}): NextRequest {
  return new NextRequest(`${init.origin ?? "http://localhost:3210"}${path}`, { method: init.method ?? "GET", headers: init.headers ?? {} });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});

describe("the routes that stay open", () => {
  it.each([
    "/api/webhooks/twilio/sms",
    "/api/webhooks/twilio/status",
    "/api/webhooks/polar",
    "/api/webhooks/stripe",
    "/api/webhooks/stripe/meter-errors",
    "/api/webhooks/resend",
    "/api/webhooks/openai/live",
    "/api/health/live",
    "/api/health/ready",
    "/embed.js",
    "/embed/wk_live_key",
    "/embed/embed.js",
    "/api/widget/config",
    "/api/widget/session",
    "/api/widget/session/verify",
    "/api/widget/chat",
    "/api/widget/stream",
    "/api/widget/history",
    "/api/widget/lead",
    "/api/voice/live/session",
    "/api/voice/live/session/end",
    "/api/v1/businesses",
    "/api/v1/openapi.json",
    "/api/mcp",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/api/auth",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/api/mcp",
    "/api/auth/oauth2/token",
    "/api/auth/oauth2/register",
    "/api/auth/oauth2/revoke",
    "/api/auth/oauth2/introspect",
    "/api/storage/local",
    "/api/internal/finance/export",
  ])("leaves %s open", (pathname) => {
    expect(isOpenRoute(pathname)).toBe(true);
  });

  it.each([
    "/",
    "/login",
    "/en/login",
    "/en/pricing",
    "/dashboard",
    "/profile/a-business",
    "/q/abc123",
    "/en/help",
    "/oauth/consent",
    "/oauth/sign-in",
    // Beside an open route, not under it.
    "/api/webhooks",
    "/api/webhook-endpoints",
    "/api/webhook-deliveries",
    "/api/health",
    "/api/health/livex",
    "/api/health/live/more",
    "/api/health/deep",
    "/embed",
    "/embed.json",
    "/embedded",
    "/api/widget",
    "/api/widget-keys",
    "/api/widget-keys/wk_1",
    "/api/voice/live/session/other",
    "/api/voice/live/sessions",
    "/api/voice/live",
    "/api/v1",
    "/api/v10/businesses",
    "/api/mcp/tools",
    "/.well-known/security.txt",
    "/.well-known/oauth-authorization-server/other",
    // The rest of sign-in, which a browser with the cookie calls.
    "/api/auth/get-session",
    "/api/auth/sign-in/email",
    "/api/auth/oauth2/authorize",
    "/api/auth/oauth2/consent",
    "/api/auth/oauth2/token/extra",
    "/api/storage/local-files",
    "/api/storage",
    "/api/internal/finance",
    "/api/internal/finance/export/all",
    "/api/branding/logo",
    // Routes match by case, so another case is another address.
    "/API/WEBHOOKS/twilio/sms",
    "/Embed.js",
  ])("keeps %s closed", (pathname) => {
    expect(isOpenRoute(pathname)).toBe(false);
  });
});

describe("the token", () => {
  it("is off without the variable, and when it is empty or blank", () => {
    expect(protectionToken({})).toBeUndefined();
    expect(protectionToken({ PROTECTION_TOKEN: "" })).toBeUndefined();
    expect(protectionToken({ PROTECTION_TOKEN: "   " })).toBeUndefined();
    expect(protectionTokenStartupError({})).toBeNull();
    expect(protectionTokenStartupError({ PROTECTION_TOKEN: " " })).toBeNull();
  });

  it("drops the spaces and line ends around a pasted token", () => {
    expect(protectionToken({ PROTECTION_TOKEN: ` ${TOKEN}\n` })).toBe(TOKEN);
    expect(protectionTokenStartupError({ PROTECTION_TOKEN: ` ${TOKEN}\n` })).toBeNull();
  });

  it("starts with 32 or more of the characters an address carries as they are", () => {
    expect(protectionTokenStartupError(on)).toBeNull();
    expect(protectionTokenStartupError({ PROTECTION_TOKEN: "a".repeat(32) })).toBeNull();
    expect(protectionTokenStartupError({ PROTECTION_TOKEN: "Az09-_.~".repeat(4) })).toBeNull();
  });

  it("refuses a short token and says how long it must be, without repeating it", () => {
    const error = protectionTokenStartupError({ PROTECTION_TOKEN: `short-token-${"x".repeat(19)}` });
    expect(error).toContain("PROTECTION_TOKEN is 31 characters long and needs at least 32");
    expect(error).not.toContain("short-token");
  });

  it.each(["+", " ", "/", "=", "&", "#", "%", "?", "é"])("refuses a token with %j, which would break the access link", (character) => {
    const token = `${"a".repeat(20)}${character}${"b".repeat(20)}`;
    const error = protectionTokenStartupError({ PROTECTION_TOKEN: token });
    expect(error).toContain("PROTECTION_TOKEN has a character an address can't carry as it is");
    expect(error).not.toContain(token);
  });

  it("lets a build through, since a build serves no one", () => {
    expect(protectionTokenStartupError({ PROTECTION_TOKEN: "short", NEXT_PHASE: "phase-production-build" })).toBeNull();
  });
});

describe("the cookie", () => {
  it("holds when it expires and a signature, never the token", () => {
    const value = accessCookieValue(TOKEN, NOW);
    expect(value).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(value).not.toContain(TOKEN);
    expect(Number(value.split(".")[1])).toBe(NOW / 1000 + ACCESS_COOKIE_MAX_AGE_SECONDS);
    expect(ACCESS_COOKIE_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it("passes for 30 days and not a second longer", () => {
    const value = accessCookieValue(TOKEN, NOW);
    expect(accessCookieIsValid(value, TOKEN, NOW)).toBe(true);
    expect(accessCookieIsValid(value, TOKEN, NOW + ACCESS_COOKIE_MAX_AGE_SECONDS * 1000 - 1)).toBe(true);
    expect(accessCookieIsValid(value, TOKEN, NOW + ACCESS_COOKIE_MAX_AGE_SECONDS * 1000)).toBe(false);
  });

  it("fails once the token changes", () => {
    expect(accessCookieIsValid(accessCookieValue(TOKEN, NOW), OTHER_TOKEN, NOW)).toBe(false);
  });

  it("fails when its expiry or its signature is altered", () => {
    const [version, expiresAt, signature] = accessCookieValue(TOKEN, NOW).split(".") as [string, string, string];
    expect(accessCookieIsValid(`${version}.${Number(expiresAt) + 1}.${signature}`, TOKEN, NOW)).toBe(false);
    const flipped = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    expect(accessCookieIsValid(`${version}.${expiresAt}.${flipped}`, TOKEN, NOW)).toBe(false);
    expect(accessCookieIsValid(`v2.${expiresAt}.${signature}`, TOKEN, NOW)).toBe(false);
  });

  it.each([undefined, "", "v1", "v1.123", "v1..", "1.2.3", TOKEN, `v1.${"9".repeat(13)}.${"a".repeat(43)}`, `v1.123.${"a".repeat(42)}`, `v1.123.${"a".repeat(43)}.more`])("fails for %j", (value) => {
    expect(accessCookieIsValid(value, TOKEN, NOW)).toBe(false);
  });

  it("takes the __Host- prefix over HTTPS only, where a browser accepts it", () => {
    expect(accessCookieName(true)).toBe("__Host-lobbystack-access");
    expect(accessCookieName(false)).toBe("lobbystack-access");
  });
});

describe("the decision for a request", () => {
  const cookie = (name = "lobbystack-access", token = TOKEN) => ({ cookie: `${name}=${accessCookieValue(token, NOW)}` });

  it("is off without the variable, whatever the request carries", () => {
    expect(decideAccess(request(`/login?access=${TOKEN}`), {}, NOW)).toEqual({ outcome: "off" });
    expect(decideAccess(request("/api/contacts", { headers: { "x-protection-token": "anything" } }), { PROTECTION_TOKEN: " " }, NOW)).toEqual({ outcome: "off" });
  });

  it("never looks at the token on an open route", () => {
    expect(decideAccess(request("/api/webhooks/twilio/sms", { method: "POST" }), on, NOW)).toEqual({ outcome: "open" });
    expect(decideAccess(request("/embed.js?access=wrong"), on, NOW)).toEqual({ outcome: "open" });
    expect(decideAccess(request(`/embed/wk_live_key?access=${TOKEN}`), on, NOW)).toEqual({ outcome: "open" });
    expect(decideAccess(request("/api/health/ready", { headers: { "x-protection-token": "wrong" } }), on, NOW)).toEqual({ outcome: "open" });
  });

  it.each(["/", "/login", "/en/login", "/api/auth/get-session", "/profile/a-business", "/q/abc123", "/api/widget-keys"])("closes %s to a request with nothing", (path) => {
    expect(decideAccess(request(path), on, NOW)).toEqual({ outcome: "deny" });
  });

  it.each(["GET", "HEAD"])("grants the cookie to a %s with the token in its address", (method) => {
    expect(decideAccess(request(`/login?access=${TOKEN}`, { method }), on, NOW)).toEqual({ outcome: "grant", token: TOKEN });
  });

  it("grants again to a browser that already holds the cookie, which renews it", () => {
    expect(decideAccess(request(`/login?access=${TOKEN}`, { headers: cookie() }), on, NOW)).toEqual({ outcome: "grant", token: TOKEN });
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("doesn't take the token from the address of a %s", (method) => {
    expect(decideAccess(request(`/api/contacts?access=${TOKEN}`, { method }), on, NOW)).toEqual({ outcome: "deny" });
  });

  it("closes the address to a token that doesn't match, and says where it came from", () => {
    expect(decideAccess(request(`/login?access=${OTHER_TOKEN}`), on, NOW)).toEqual({ outcome: "deny", wrongToken: "query" });
    expect(decideAccess(request("/login?access="), on, NOW)).toEqual({ outcome: "deny", wrongToken: "query" });
    expect(decideAccess(request(`/login?access=${TOKEN}x`), on, NOW)).toEqual({ outcome: "deny", wrongToken: "query" });
    expect(decideAccess(request(`/login?access=${TOKEN.slice(0, -1)}`), on, NOW)).toEqual({ outcome: "deny", wrongToken: "query" });
    expect(decideAccess(request("/api/contacts", { headers: { "x-protection-token": OTHER_TOKEN } }), on, NOW)).toEqual({ outcome: "deny", wrongToken: "header" });
  });

  it.each(["GET", "POST", "DELETE"])("passes a %s from a script that sends the header", (method) => {
    expect(decideAccess(request("/api/contacts", { method, headers: { "x-protection-token": TOKEN } }), on, NOW)).toEqual({ outcome: "pass" });
  });

  it("passes a browser that holds the cookie, on every method", () => {
    expect(decideAccess(request("/dashboard", { headers: cookie() }), on, NOW)).toEqual({ outcome: "pass" });
    expect(decideAccess(request("/api/contacts", { method: "POST", headers: cookie() }), on, NOW)).toEqual({ outcome: "pass" });
    // An old link in a browser that is already in: the page opens, and nothing is logged.
    expect(decideAccess(request(`/login?access=${OTHER_TOKEN}`, { headers: cookie() }), on, NOW)).toEqual({ outcome: "pass" });
  });

  it("closes the address once the cookie has expired or the token has changed", () => {
    expect(decideAccess(request("/dashboard", { headers: cookie() }), on, NOW + ACCESS_COOKIE_MAX_AGE_SECONDS * 1000)).toEqual({ outcome: "deny" });
    expect(decideAccess(request("/dashboard", { headers: cookie() }), { PROTECTION_TOKEN: OTHER_TOKEN }, NOW)).toEqual({ outcome: "deny" });
    expect(decideAccess(request("/dashboard", { headers: { cookie: "lobbystack-access=v1.1.forged" } }), on, NOW)).toEqual({ outcome: "deny" });
  });

  it("reads the cookie under the name the connection gives it", () => {
    const https = "https://test.example.test";
    expect(decideAccess(request("/dashboard", { origin: https, headers: cookie("__Host-lobbystack-access") }), on, NOW)).toEqual({ outcome: "pass" });
    expect(decideAccess(request("/dashboard", { origin: https, headers: cookie("lobbystack-access") }), on, NOW)).toEqual({ outcome: "deny" });
    expect(decideAccess(request("/dashboard", { headers: cookie("__Host-lobbystack-access") }), on, NOW)).toEqual({ outcome: "deny" });
  });

  it("lets nothing through a token the admin would not start with, and still leaves open routes open", () => {
    const short = { PROTECTION_TOKEN: "short" };
    expect(decideAccess(request("/login?access=short"), short, NOW)).toEqual({ outcome: "deny" });
    expect(decideAccess(request("/api/contacts", { headers: { "x-protection-token": "short" } }), short, NOW)).toEqual({ outcome: "deny" });
    expect(decideAccess(request("/api/health/live"), short, NOW)).toEqual({ outcome: "open" });
  });
});

describe("the gate's own answers", () => {
  it("sends the browser to the same address without the token, keeping the rest of it", () => {
    const response = accessGrantedResponse(request(`/login?returnTo=%2Fsettings%2Fwidget&access=${TOKEN}&lng=fr`), TOKEN, NOW);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3210/login?returnTo=%2Fsettings%2Fwidget&lng=fr");
    const home = accessGrantedResponse(request(`/?access=${TOKEN}`), TOKEN, NOW);
    expect(home.headers.get("location")).toBe("http://localhost:3210/");
    expect(home.headers.get("location")).not.toContain(TOKEN);
  });

  it("sets a cookie that scripts can't read, for 30 days, that comes along on a link from another site", () => {
    const response = accessGrantedResponse(request(`/login?access=${TOKEN}`, { origin: "https://test.example.test" }), TOKEN, NOW);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`__Host-lobbystack-access=${accessCookieValue(TOKEN, NOW)}`);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain(`Max-Age=${ACCESS_COOKIE_MAX_AGE_SECONDS}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie).not.toContain("Domain");
    expect(setCookie).not.toContain(TOKEN);
    expect(accessCookieIsValid(response.cookies.get("__Host-lobbystack-access")?.value, TOKEN, NOW)).toBe(true);
  });

  it("sets the bare name without Secure over plain HTTP, so a server on localhost can be tried", () => {
    const setCookie = accessGrantedResponse(request(`/login?access=${TOKEN}`), TOKEN, NOW).headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^lobbystack-access=v1\./);
    expect(setCookie).not.toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
  });

  it("answers a closed address with two words and nothing else", async () => {
    const response = accessDeniedResponse();
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toBe("Not found");
  });
});

describe("the warning about a token that doesn't match", () => {
  it("is one line a minute at most, counts what it left out, and never names a token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A fresh copy, so the minute other tests started doesn't count here.
    const { reportWrongAccessToken } = await import("./access-gate");
    reportWrongAccessToken("query", NOW);
    reportWrongAccessToken("query", NOW + 1_000);
    reportWrongAccessToken("header", NOW + 59_999);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({ level: "warn", message: "access_gate.wrong_token", via: "query", detail: expect.stringContaining("PROTECTION_TOKEN") });
    reportWrongAccessToken("header", NOW + 60_000);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(warn.mock.calls[1]?.[0]))).toMatchObject({ level: "warn", message: "access_gate.wrong_token", via: "header", notLogged: 2 });
  });
});
