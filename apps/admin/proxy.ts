import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { BRAND_LOGO_PATH, isMaintenanceMode, normalizeInterfaceLocale } from "@lobbystack/shared";

import { ACCESS_GATE_ROBOTS, ACCESS_HEADER, accessDeniedResponse, accessGrantedResponse, decideAccess, reportWrongAccessToken } from "@/lib/access-gate";
import { configuredAppOrigins } from "@/lib/app-origins";
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE_SECONDS, localeTag } from "@/lib/locale";
import { DEFAULT_HELP_LOCALE, helpLocaleFor, isHelpLocale } from "@/lib/help/locales";
import {
  isCanonicalPublicPath,
  isHelpRoutePath,
  isLegacyPublicRoutePath,
  isPublicRoutePath,
  isTokenBearingRoute,
  localeFromPathname,
  localizePublicPath,
} from "@/lib/locale-path";
import {
  LOCALE_HEADER,
  LOCALE_SOURCE_HEADER,
  NONCE_HEADER,
  PATHNAME_HEADER,
  type NegotiatedLocale,
  localeFromCookieHeader,
  negotiateLocale,
} from "@/lib/locale-request";

import { brandLogoSecurityHeaders, cspScriptNonceState, embeddableSecurityHeaders, entryLinkSecurityHeaders, isEmbeddablePath, isEntryLinkPath, isPublicProfilePath, publicProfileSecurityHeaders, securityHeaders } from "./security-headers";

const stateChangingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// /api/v1 and /api/mcp authenticate with bearer API keys only, never cookies, so they need no CSRF
// origin check. /api/mcp refuses foreign browser origins itself.
// "/api/widget/" keeps its slash so the cookie-authenticated /api/widget-keys admin route stays guarded.
const csrfExemptPrefixes = ["/api/auth", "/api/webhooks", "/api/health", "/api/voice", "/api/widget/", "/api/v1/", "/api/mcp"];
// /api/storage/local authorizes each upload with a signed token in its URL, never a cookie, and
// API clients such as the CLI send no Origin header. It is matched exactly so routes added beside it stay guarded.
const csrfExemptPaths = new Set(["/api/storage/local"]);

function isWebhookPath(pathname: string): boolean {
  return pathname.startsWith("/api/webhooks/");
}

function isMaintenanceHealthProbe(pathname: string, method: string): boolean {
  return (method === "GET" || method === "HEAD") && (pathname === "/api/health/live" || pathname === "/api/health/ready");
}

function maintenanceResponse(headers: Record<string, string>): NextResponse {
  return new NextResponse("Service temporarily unavailable.", {
    status: 503,
    headers: { ...headers, "Cache-Control": "no-store", "Retry-After": "60" },
  });
}

// The access gate's own answers, the 404 and the 303 that sets its cookie, are never stored.
function accessGateResponse(response: NextResponse, headers: Record<string, string>): NextResponse {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  if (process.env.NODE_ENV === "production") response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Robots-Tag", ACCESS_GATE_ROBOTS);
  return response;
}

function applyResponsePolicy(
  response: NextResponse,
  request: NextRequest,
  headers: Record<string, string>,
  locale: NegotiatedLocale,
  cacheControl?: string,
): NextResponse {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  if (process.env.NODE_ENV === "production") response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (cacheControl) response.headers.set("Cache-Control", cacheControl);
  if (isCanonicalPublicPath(request.nextUrl.pathname)) {
    response.headers.set("Content-Language", localeTag(locale.locale));
    response.headers.set("Vary", "Accept-Encoding");
  }
  // Never add Set-Cookie to canonical locale-prefixed pages: shared caches must
  // be able to store those responses. Explicit selection persists separately,
  // except on a help address, whose language says nothing about the reader's.
  if (locale.source === "query" && !isHelpRoutePath(request.nextUrl.pathname)) {
    response.cookies.set({
      name: LOCALE_COOKIE,
      value: locale.locale,
      path: "/",
      maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
    });
  }
  return response;
}

function cacheControlForRequest(pathname: string, searchParams: URLSearchParams): string | undefined {
  if (isTokenBearingRoute(pathname, searchParams)) return "private, no-store";
  if (pathname.startsWith("/api/realtime") || pathname.startsWith("/api/widget/chat") || pathname.startsWith("/api/widget/stream")) {
    return "private, no-cache, no-store, no-transform";
  }
  // The logo route caches its own versioned responses for good.
  if (pathname === BRAND_LOGO_PATH) return undefined;
  if (pathname.startsWith("/api/") || pathname.startsWith("/embed/")) {
    return "private, no-store";
  }
  if (isCanonicalPublicPath(pathname)) {
    return "public, s-maxage=300, stale-while-revalidate=3600";
  }
  if (!isPublicRoutePath(pathname) && pathname !== "/embed.js") return "private, no-store";
  return undefined;
}

// Same list Better Auth trusts, plus the request's own origin.
function configuredOrigins(request: NextRequest): Set<string> {
  return new Set([request.nextUrl.origin, ...configuredAppOrigins(process.env, [], true)]);
}

function hasValidCsrfOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin") ?? (() => {
    const referer = request.headers.get("referer");
    if (!referer) return null;
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  })();
  return origin !== null && configuredOrigins(request).has(origin.replace(/\/$/, ""));
}

/**
 * A fresh nonce per request, for the policy that replaces `'unsafe-inline'`
 * (AUDIT-008). It is made only when a setting asks for one, so a deployment
 * that hasn't turned it on pays nothing and gets byte-for-byte the policy it
 * had before.
 *
 * A public page under its language gets none, whatever the settings say. Its
 * HTML was written at build time, so Next has no request in which to put a
 * nonce on its scripts, and under the strict policy every one of them would be
 * blocked: a sign-in page nobody can sign in on. A shared cache may also store
 * the response, and a nonce handed to everyone is not a nonce. Those pages keep
 * the policy they had. `scripts/verify-admin-prerender.ts` fails the build if a
 * page is ever prerendered outside that set.
 *
 * The widget's loader gets none for the second reason: it is a script file
 * that caches hand to every site's visitors, and a policy sent with a script
 * file governs nothing.
 */
function scriptNonce(pathname: string): string | undefined {
  if (cspScriptNonceState(process.env) === "off" || isCanonicalPublicPath(pathname) || pathname === "/embed.js") return undefined;
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const nonce = scriptNonce(pathname);
  const headers = isEmbeddablePath(pathname)
    ? embeddableSecurityHeaders(process.env, nonce)
    : pathname === BRAND_LOGO_PATH
      ? brandLogoSecurityHeaders()
      : isPublicProfilePath(pathname) ? publicProfileSecurityHeaders(process.env, nonce)
        : isEntryLinkPath(pathname) ? entryLinkSecurityHeaders(process.env, nonce) : securityHeaders(process.env, nonce);

  // The access gate (PROTECTION_TOKEN, docs/features/access-gate.md) answers
  // first, before maintenance mode, so a closed address says the same 404
  // whatever state the deployment is in. Open routes go on as if it were off.
  const access = decideAccess(request);
  if (access.outcome === "deny") {
    if (access.wrongToken) reportWrongAccessToken(access.wrongToken);
    return accessGateResponse(accessDeniedResponse(), headers);
  }
  if (access.outcome === "grant") return accessGateResponse(accessGrantedResponse(request, access.token), headers);
  const response = route(request, headers, access.outcome, nonce);
  // A test deployment stays out of search results, the widget's and the API's answers included.
  if (access.outcome !== "off") response.headers.set("X-Robots-Tag", ACCESS_GATE_ROBOTS);
  return response;
}

// Everything the proxy did before the access gate. `access` is "pass" for an
// address the gate let through: its answer is one visitor's alone.
function route(request: NextRequest, headers: Record<string, string>, access: "off" | "open" | "pass", nonce?: string): NextResponse {
  const { pathname } = request.nextUrl;
  const gated = access === "pass";
  // A page a shared cache could store would reach a stranger without the cookie.
  const cacheControl = gated ? "private, no-store" : cacheControlForRequest(pathname, request.nextUrl.searchParams);

  const isApiRequest = pathname.startsWith("/api/");
  if (isMaintenanceMode(process.env) && (isWebhookPath(pathname) || (isApiRequest && !isMaintenanceHealthProbe(pathname, request.method)) || stateChangingMethods.has(request.method))) {
    // Webhooks are rejected before their handlers can validate, enqueue, or acknowledge them.
    // Health probes are the only API exemption: GET handlers can perform side effects.
    return maintenanceResponse(headers);
  }

  const negotiatedLocale = negotiateLocale({
    query: request.nextUrl.searchParams.get("lng"),
    cookie: localeFromCookieHeader(request.headers.get("cookie")),
    acceptLanguage: request.headers.get("accept-language"),
  });
  const pathLocale = localeFromPathname(pathname);
  const queryLocale = normalizeInterfaceLocale(request.nextUrl.searchParams.get("lng"));

  if (isLegacyPublicRoutePath(pathname)) {
    const target = request.nextUrl.clone();
    target.pathname = localizePublicPath(pathname, isHelpRoutePath(pathname) ? helpLocaleFor(negotiatedLocale.locale) : negotiatedLocale.locale);
    target.searchParams.delete("lng");
    return applyResponsePolicy(
      NextResponse.redirect(target, 308),
      request,
      headers,
      negotiatedLocale,
      "private, no-store",
    );
  }

  // Help pages exist in fewer languages than the interface, so an address in
  // another language goes to the default help language. It's temporary: the
  // address works once that language's help is written.
  if (pathLocale && isHelpRoutePath(pathname) && !isHelpLocale(pathLocale)) {
    const target = request.nextUrl.clone();
    target.pathname = localizePublicPath(pathname, DEFAULT_HELP_LOCALE);
    target.searchParams.delete("lng");
    return applyResponsePolicy(
      NextResponse.redirect(target, 307),
      request,
      headers,
      negotiatedLocale,
      "private, no-store",
    );
  }

  if (pathLocale && isPublicRoutePath(pathname) && request.nextUrl.searchParams.has("lng")) {
    const targetLocale = queryLocale ?? pathLocale;
    const target = request.nextUrl.clone();
    target.pathname = localizePublicPath(pathname, isHelpRoutePath(pathname) ? helpLocaleFor(targetLocale) : targetLocale);
    target.searchParams.delete("lng");
    return applyResponsePolicy(
      NextResponse.redirect(target, 308),
      request,
      headers,
      { locale: targetLocale, source: queryLocale ? "query" : "path" },
      "private, no-store",
    );
  }

  // The website widget's loader names the language the widget's settings set in
  // the chat's address, so the chat paints in it from the start. That is the
  // business's choice, not the visitor's, so unlike ?lng= it is never saved.
  // Without one, the browser's languages decide, as they do once the chat loads.
  const widgetLocale = pathname.startsWith("/embed/") ? normalizeInterfaceLocale(request.nextUrl.searchParams.get("locale")) : null;

  // Dynamic application roots read these headers. Locale-prefixed public roots
  // derive their first paint directly from the path and remain prerenderable.
  const locale: NegotiatedLocale = widgetLocale
    ? { locale: widgetLocale, source: "path" }
    : pathLocale && isPublicRoutePath(pathname)
      ? { locale: pathLocale, source: "path" }
      : negotiatedLocale;
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(LOCALE_HEADER, locale.locale);
  requestHeaders.set(LOCALE_SOURCE_HEADER, locale.source);
  requestHeaders.set(PATHNAME_HEADER, pathname);
  if (nonce) {
    requestHeaders.set(NONCE_HEADER, nonce);
    // Next puts the nonce on the scripts it writes by reading it out of the
    // request's policy, and before it looks it copies this response's policy
    // over the request's. So the policy enforced here is the one Next reads,
    // and it carries the nonce in both steps (security-headers.ts). Setting it
    // on the request too is what Next's guide does, for a host that doesn't copy.
    requestHeaders.set("Content-Security-Policy", headers["Content-Security-Policy"] ?? "");
  }
  // The token a script sent has done its work, and an open route never needed it:
  // pages, routes and their error reports never see it.
  if (access !== "off") requestHeaders.delete(ACCESS_HEADER);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applyResponsePolicy(response, request, headers, locale, cacheControl);

  if (stateChangingMethods.has(request.method) && pathname.startsWith("/api/") && !csrfExemptPaths.has(pathname) && !csrfExemptPrefixes.some((prefix) => pathname.startsWith(prefix)) && !hasValidCsrfOrigin(request)) {
    return applyResponsePolicy(
      NextResponse.json({ error: "CSRF origin validation failed." }, { status: 403 }),
      request,
      headers,
      locale,
      cacheControl,
    );
  }
  return response;
}

export const config = {
  // Ordinary public assets keep the headers configured in next.config.ts without
  // paying for a proxy execution on every request.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico$|locales/|brand/|lobbystack-logo\\.svg$).*)"],
};
