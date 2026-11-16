import { envFlag } from "@lobbystack/shared";

import { posthogSources, recordingStorageSource } from "./csp";

export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";

/**
 * `script-src 'self' 'unsafe-inline'` means the policy would not stop an
 * injected script from running (AUDIT-008). A per-request nonce with
 * `'strict-dynamic'` fixes that, but only once every inline script the app
 * renders carries the nonce, and a missed one is a blank screen. So it arrives
 * in three steps, each a setting:
 *
 * 1. Neither set: today's policy, `'unsafe-inline'`, nothing else sent.
 * 2. `CSP_SCRIPT_NONCE=true`: the strict policy goes out as
 *    `Content-Security-Policy-Report-Only` beside one that still blocks
 *    nothing new. The browser's console names anything that would have been.
 * 3. `CSP_SCRIPT_NONCE_ENFORCED=true` as well: the strict policy becomes the
 *    enforced one and the report-only header stops.
 *
 * The proxy makes the nonce. Next puts it on the scripts it writes by reading
 * it out of the policy the proxy enforces, never the report-only one while an
 * enforced one is there, so in step 2 the enforced policy has to carry the
 * nonce without acting on it: see `securityHeaders`.
 *
 * A page built ahead of time gets no nonce and keeps today's policy in every
 * step, because there is no request in which Next could write one on its
 * scripts. The proxy decides which pages those are.
 */
export function cspScriptNonceState(env: Record<string, string | undefined> = process.env): "off" | "reporting" | "enforced" {
  if (!envFlag(env, "CSP_SCRIPT_NONCE")) return "off";
  return envFlag(env, "CSP_SCRIPT_NONCE_ENFORCED") ? "enforced" : "reporting";
}

/**
 * Single source of truth for the security headers the admin app sends.
 *
 * Both the proxy and next.config.ts emit these values, so their ownership lives here.
 * Embeddable routes intentionally differ: they must stay frameable across origins, and
 * the server config must not re-add the global X-Frame-Options: DENY on top of them.
 */

export function securityHeaders(env: Record<string, string | undefined> = process.env, nonce?: string): Record<string, string> {
  const recordingOrigin = recordingStorageSource(env);
  const posthogOrigin = posthogSources(env).join(" ");
  const developmentEval = env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const scriptHosts = `https://challenges.cloudflare.com ${posthogOrigin}`;
  const policy = (script: string): string => [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    script,
    // Tailwind writes the chart colours of a screen as an inline <style>, so
    // styles keep 'unsafe-inline'; a style can't run code.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    `connect-src 'self' ${posthogOrigin} https://challenges.cloudflare.com${recordingOrigin ? ` ${recordingOrigin}` : ""} wss:`,
    "font-src 'self' data:",
    "frame-src 'self' https://challenges.cloudflare.com",
    "form-action 'self'",
    `media-src 'self' blob:${recordingOrigin ? ` ${recordingOrigin}` : ""}`,
    "worker-src 'self' blob:",
  ].join("; ");
  const state = nonce ? cspScriptNonceState(env) : "off";
  const strict = (evalSource: string): string => policy(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${evalSource} ${scriptHosts}`);
  return {
    "Content-Security-Policy": state === "enforced" ? strict(developmentEval)
      : state === "reporting" ? policy(nonceCarryingScriptSources(nonce, developmentEval, scriptHosts))
        : policy(`script-src 'self' 'unsafe-inline'${developmentEval} ${scriptHosts}`),
    // The report is there to name what the strict policy would start to block.
    // `eval` isn't that: every step refuses it, as today's policy does, and a
    // library that asks whether it may (zod does, as each page loads) is told
    // no without anyone noticing. Reported on, the same question would put a
    // line in every page's console, so the report alone lets `eval` through.
    ...(state === "reporting" ? { [CSP_REPORT_ONLY_HEADER]: strict(" 'unsafe-eval'") } : {}),
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-DNS-Prefetch-Control": "off",
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
  };
}

/**
 * What the enforced policy says about scripts while the strict one is only
 * reported on: it names the nonce and allows what it allowed before.
 *
 * It has to name the nonce because the enforced policy is where Next looks
 * for it. Next copies the proxy's response headers over the request's and
 * reads the first directive that starts with `script-src`, so that has to be
 * `script-src` itself, with the nonce in it. On its own that would start
 * enforcing: a nonce in a directive switches its `'unsafe-inline'` off. So
 * `script-src-elem` and `script-src-attr` follow, saying what `script-src`
 * said before. A browser that knows them (Chrome 75, Firefox 108, Safari 15.4,
 * all 2022 or earlier) asks them about every script and every handler, and
 * asks `script-src` only about `eval`, which it refused already.
 *
 * An older browser doesn't know them and enforces `script-src` with its nonce.
 * It still loads this app, whose scripts all carry it, but for that browser
 * step 2 is already step 3 without `'strict-dynamic'`.
 */
function nonceCarryingScriptSources(nonce: string | undefined, developmentEval: string, scriptHosts: string): string {
  return [
    `script-src 'self' 'unsafe-inline' 'nonce-${nonce}'${developmentEval} ${scriptHosts}`,
    `script-src-elem 'self' 'unsafe-inline' ${scriptHosts}`,
    "script-src-attr 'unsafe-inline'",
  ].join("; ");
}

/**
 * Rewrites both policies, so a variant can't change the enforced one and leave
 * the report-only one saying something else.
 */
function rewriteCsp(headers: Record<string, string>, change: (policy: string) => string): Record<string, string> {
  const rewritten = { ...headers };
  for (const header of ["Content-Security-Policy", CSP_REPORT_ONLY_HEADER]) {
    const policy = rewritten[header];
    if (policy !== undefined) rewritten[header] = change(policy);
  }
  return rewritten;
}

/** The same policy set, but frameable across origins and without the DENY framing header. */
export function embeddableSecurityHeaders(env: Record<string, string | undefined> = process.env, nonce?: string): Record<string, string> {
  const { "X-Frame-Options": _deny, ...rest } = securityHeaders(env, nonce);
  return rewriteCsp(rest, (policy) => policy.replace("frame-ancestors 'none'", "frame-ancestors *"));
}

/** A business's public page, /profile/<slug>, or one of its receptionists' pages, /profile/<slug>/<handle> (receptionistPagePath in @lobbystack/shared). */
export function isPublicProfilePath(pathname: string): boolean {
  return pathname.startsWith("/profile/");
}

/**
 * A business's public page frames its own chat, which is same-origin, and the
 * map of its address from Google Maps. The map's origin is allowed whether or
 * not the deployment has a Maps key, because next.config.ts fixes its headers
 * at build time.
 */
export function publicProfileSecurityHeaders(env: Record<string, string | undefined> = process.env, nonce?: string): Record<string, string> {
  return rewriteCsp(securityHeaders(env, nonce), (policy) =>
    policy.replace("frame-src 'self' https://challenges.cloudflare.com", "frame-src 'self' https://challenges.cloudflare.com https://www.google.com"));
}

/** A QR sign's short link, /q/<code> (entryLinkPath in @lobbystack/shared). */
export function isEntryLinkPath(pathname: string): boolean {
  return /^\/q\/[^/]+$/.test(pathname);
}

/**
 * A QR link only redirects to a business's page, and passes no referrer on to
 * it. The proxy and next.config.ts set their headers over the route's, so the
 * policy lives here.
 */
export function entryLinkSecurityHeaders(env: Record<string, string | undefined> = process.env, nonce?: string): Record<string, string> {
  return { ...securityHeaders(env, nonce), "Referrer-Policy": "no-referrer" };
}

/**
 * The logo onboarding saved may be an SVG, and an SVG opened on its own is a
 * document. Serve it with no script, no requests and a sandbox, whichever of
 * the proxy, next.config.ts or the route sets the header last.
 */
export const BRAND_LOGO_SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
};

export function brandLogoSecurityHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  // Its own policy allows no script at all, so a nonce would say nothing; the
  // report-only header is dropped with it rather than contradicting it.
  const { [CSP_REPORT_ONLY_HEADER]: _reportOnly, ...rest } = securityHeaders(env);
  return { ...rest, ...BRAND_LOGO_SECURITY_HEADERS };
}

/** Header records converted to the shape the next.config.ts headers array expects. */
export function toNextHeaderList(headers: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(headers).map(([key, value]) => ({ key, value }));
}

/** Iframe document routes that must stay embeddable across origins. */
export const EMBED_PATH_PREFIXES = ["/embed.js", "/embed/"] as const;

export function isEmbeddablePath(pathname: string): boolean {
  return EMBED_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

