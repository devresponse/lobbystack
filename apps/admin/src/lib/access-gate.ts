import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * The access gate closes a test deployment to strangers
 * (docs/features/access-gate.md). With PROTECTION_TOKEN set on the admin,
 * every address answers a bare 404 until a browser opens one with
 * `?access=<the token>` once: that answers 303 to the same address without
 * the token and leaves a signed cookie. Routes that other services and
 * visitors' browsers call without that cookie stay open (`isOpenRoute`).
 * Without the variable none of this runs.
 */

type Env = Record<string, string | undefined>;

export const PROTECTION_TOKEN_MIN_LENGTH = 32;
/** The query parameter an access link carries: `https://<host>/login?access=<the token>`. */
export const ACCESS_QUERY_PARAM = "access";
/** The header a script sends instead of the link and the cookie. */
export const ACCESS_HEADER = "x-protection-token";
export const ACCESS_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const ACCESS_GATE_ROBOTS = "noindex, nofollow";

const COOKIE_NAME = "lobbystack-access";
// The characters an address carries as they are (RFC 3986's unreserved set), so
// the access link works exactly as written: a "+" would arrive as a space.
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/;
const COOKIE_PATTERN = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

// Called by a service, or by a visitor's browser on another website, that has
// no way to hold the cookie. Each has its own check: a signature, a key, a
// signed address or a token. A prefix keeps its closing slash so a route added
// beside it stays closed: "/api/widget/" does not open /api/widget-keys.
const OPEN_PREFIXES = [
  "/api/webhooks/", // Twilio, the billing provider, the email provider and OpenAI, each checked by its signature
  "/embed/", // the website widget's chat, framed by a business's website
  "/api/widget/", // what that chat calls
  "/api/v1/", // the public API, by API key: the CLI, Zapier, Make and n8n
];
const OPEN_PATHS = new Set([
  "/api/health/live", // the host's probes
  "/api/health/ready",
  "/embed.js", // the website widget's loader
  "/api/voice/live/session", // a call from the website widget
  "/api/voice/live/session/end",
  "/api/mcp", // MCP clients, by OAuth token or API key
  "/.well-known/oauth-authorization-server", // what an MCP client reads and calls before and after its user signs in
  "/.well-known/oauth-authorization-server/api/auth",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/api/mcp",
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/register",
  "/api/auth/oauth2/revoke",
  "/api/auth/oauth2/introspect",
  "/api/storage/local", // an upload or download by its signed address
  "/api/internal/finance/export", // the finance export, by its own bearer token
  "/api/internal/fleet", // the fleet status address an uptime check watches, by its own token
]);

/** Whether an address answers without the cookie while the gate is on. */
export function isOpenRoute(pathname: string): boolean {
  return OPEN_PATHS.has(pathname) || OPEN_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** The token set on the admin, or undefined when the gate is off. */
export function protectionToken(env: Env = process.env): string | undefined {
  return env.PROTECTION_TOKEN?.trim() || undefined;
}

function tokenProblem(token: string): string | null {
  if (token.length < PROTECTION_TOKEN_MIN_LENGTH) return `is ${token.length} characters long and needs at least ${PROTECTION_TOKEN_MIN_LENGTH}`;
  if (!TOKEN_PATTERN.test(token)) return "has a character an address can't carry as it is";
  return null;
}

/**
 * Why the admin must not start with this token: a short one can be guessed,
 * and one with other characters breaks the access link. Null when the token
 * is right, when there is none, and during a build, which serves no one.
 * The message never repeats the token.
 */
export function protectionTokenStartupError(env: Env = process.env): string | null {
  if (env.NEXT_PHASE === "phase-production-build") return null;
  const token = protectionToken(env);
  const problem = token ? tokenProblem(token) : null;
  return problem
    ? `[access-gate] PROTECTION_TOKEN ${problem}. Use ${PROTECTION_TOKEN_MIN_LENGTH} or more random letters, digits, hyphens and underscores, or remove the variable to leave the deployment open.`
    : null;
}

// Hashing both sides first compares in the same time whatever their lengths.
function secretsMatch(offered: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(offered).digest(), createHash("sha256").update(expected).digest());
}

function cookieSignature(token: string, expiresAt: number): string {
  return createHmac("sha256", token).update(`${COOKIE_NAME}.v1.${expiresAt}`).digest("base64url");
}

/**
 * The cookie's name. Over HTTPS it has the `__Host-` prefix, which a browser
 * accepts only from this host, over HTTPS, for every path. A browser refuses
 * that prefix over plain HTTP, so a server on localhost uses the bare name.
 */
export function accessCookieName(secure: boolean): string {
  return secure ? `__Host-${COOKIE_NAME}` : COOKIE_NAME;
}

/**
 * The cookie's value: when it expires, signed with the token. It doesn't hold
 * the token, and a new token makes every cookie signed with the old one fail.
 */
export function accessCookieValue(token: string, nowMs: number = Date.now()): string {
  const expiresAt = Math.floor(nowMs / 1000) + ACCESS_COOKIE_MAX_AGE_SECONDS;
  return `v1.${expiresAt}.${cookieSignature(token, expiresAt)}`;
}

export function accessCookieIsValid(value: string | undefined, token: string, nowMs: number = Date.now()): boolean {
  const match = value ? COOKIE_PATTERN.exec(value) : null;
  if (!match) return false;
  const expiresAt = Number(match[1]);
  return expiresAt * 1000 > nowMs && secretsMatch(match[2]!, cookieSignature(token, expiresAt));
}

export type AccessDecision =
  /** No PROTECTION_TOKEN: the proxy answers as it always has. */
  | { outcome: "off" }
  /** An open route, which never looks at the token or the cookie. */
  | { outcome: "open" }
  /** The browser holds the cookie, or the request carries the header. */
  | { outcome: "pass" }
  /** The address carries the token: answer 303 without it and set the cookie. */
  | { outcome: "grant"; token: string }
  /** Answer the bare 404. `wrongToken` says where a token that doesn't match came from. */
  | { outcome: "deny"; wrongToken?: "query" | "header" };

export function decideAccess(request: NextRequest, env: Env = process.env, nowMs: number = Date.now()): AccessDecision {
  const token = protectionToken(env);
  if (!token) return { outcome: "off" };
  const { pathname, protocol, searchParams } = request.nextUrl;
  if (isOpenRoute(pathname)) return { outcome: "open" };
  // The admin doesn't start with such a token. If this runs anyway, nothing can pass.
  if (tokenProblem(token)) return { outcome: "deny" };

  // Only a page load exchanges the token for the cookie. A script sends the header.
  const offered = request.method === "GET" || request.method === "HEAD" ? searchParams.get(ACCESS_QUERY_PARAM) : null;
  if (offered !== null && secretsMatch(offered, token)) return { outcome: "grant", token };
  const header = request.headers.get(ACCESS_HEADER);
  if (header !== null && secretsMatch(header, token)) return { outcome: "pass" };
  if (accessCookieIsValid(request.cookies.get(accessCookieName(protocol === "https:"))?.value, token, nowMs)) return { outcome: "pass" };
  return offered !== null ? { outcome: "deny", wrongToken: "query" } : header !== null ? { outcome: "deny", wrongToken: "header" } : { outcome: "deny" };
}

/** 303 to the same address without the token, so it stays out of the address bar, with the cookie. */
export function accessGrantedResponse(request: NextRequest, token: string, nowMs: number = Date.now()): NextResponse {
  const target = request.nextUrl.clone();
  target.searchParams.delete(ACCESS_QUERY_PARAM);
  const response = NextResponse.redirect(target, 303);
  const secure = request.nextUrl.protocol === "https:";
  response.cookies.set({
    name: accessCookieName(secure),
    value: accessCookieValue(token, nowMs),
    path: "/",
    maxAge: ACCESS_COOKIE_MAX_AGE_SECONDS,
    httpOnly: true,
    // Lax, so the cookie comes along when Google or the billing provider sends the browser back.
    sameSite: "lax",
    secure,
  });
  return response;
}

/** The same answer for every closed address: no page, no name, nothing to tell a real address from a made-up one. */
export function accessDeniedResponse(): NextResponse {
  return new NextResponse("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

const WRONG_TOKEN_WARNING_INTERVAL_MS = 60_000;
let lastWrongTokenWarningAt = 0;
let wrongTokensNotLogged = 0;

/**
 * One warning a minute at most, so guessing can't fill the log, and never with
 * the value. The proxy is built apart from the rest of the admin, so this
 * writes the line `logEvent` would (level and message, which Railway reads)
 * without loading the telemetry package into it; console warnings reach the
 * OTel logs as well.
 */
export function reportWrongAccessToken(via: "query" | "header", nowMs: number = Date.now()): void {
  if (nowMs - lastWrongTokenWarningAt < WRONG_TOKEN_WARNING_INTERVAL_MS) {
    wrongTokensNotLogged += 1;
    return;
  }
  const notLogged = wrongTokensNotLogged;
  lastWrongTokenWarningAt = nowMs;
  wrongTokensNotLogged = 0;
  console.warn(JSON.stringify({
    level: "warn",
    message: "access_gate.wrong_token",
    via,
    ...(notLogged > 0 ? { notLogged } : {}),
    detail: "A request offered an access token that isn't PROTECTION_TOKEN and got the 404. Someone may hold an access link from before the token changed: send them the current one.",
  }));
}
