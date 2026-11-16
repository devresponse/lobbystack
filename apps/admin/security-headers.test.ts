import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";
import { expect, it } from "vitest";

import { entryLinkPath, publicProfilePath, receptionistPagePath } from "@lobbystack/shared";

import { brandLogoSecurityHeaders, CSP_REPORT_ONLY_HEADER, cspScriptNonceState, EMBED_PATH_PREFIXES, embeddableSecurityHeaders, entryLinkSecurityHeaders, isEmbeddablePath, isEntryLinkPath, isPublicProfilePath, publicProfileSecurityHeaders, securityHeaders, toNextHeaderList } from "./security-headers";

const env = { NODE_ENV: "production" } as Record<string, string | undefined>;

it("denies framing for regular app routes", () => {
  const headers = securityHeaders(env);
  expect(headers["X-Frame-Options"]).toBe("DENY");
  expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  expect(headers["X-Content-Type-Options"]).toBe("nosniff");
});

it("keeps embeddable routes frameable without conflicting framing headers", () => {
  const headers = embeddableSecurityHeaders(env);
  expect(headers).not.toHaveProperty("X-Frame-Options");
  expect(headers["Content-Security-Policy"]).toContain("frame-ancestors *");
  expect(headers["Content-Security-Policy"]).not.toContain("frame-ancestors 'none'");
  expect(headers["X-Content-Type-Options"]).toBe("nosniff");
});

it("classifies only the embed surfaces as embeddable", () => {
  for (const prefix of EMBED_PATH_PREFIXES) {
    expect(isEmbeddablePath(prefix)).toBe(true);
  }
  expect(isEmbeddablePath("/embed/abc123")).toBe(true);
  expect(isEmbeddablePath("/embedding")).toBe(false);
  expect(isEmbeddablePath("/embed")).toBe(false);
  expect(isEmbeddablePath("/login")).toBe(false);
});

it("converts header records into the next.config header list shape", () => {
  expect(toNextHeaderList({ "X-Frame-Options": "DENY" })).toEqual([{ key: "X-Frame-Options", value: "DENY" }]);
});

it("lets a business's public page frame its chat and a Google map, and nothing else new", () => {
  const headers = publicProfileSecurityHeaders(env);
  const csp = headers["Content-Security-Policy"] ?? "";
  expect(csp).toContain("frame-src 'self' https://challenges.cloudflare.com https://www.google.com");
  expect(csp.replace(" https://www.google.com", "")).toBe(securityHeaders(env)["Content-Security-Policy"]);
  // The page itself still can't be framed.
  expect(headers["X-Frame-Options"]).toBe("DENY");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(isPublicProfilePath(publicProfilePath("acme-dental"))).toBe(true);
  // A receptionist's page frames the same chat and map.
  expect(isPublicProfilePath(receptionistPagePath("acme-dental", "kitsilano"))).toBe(true);
  expect(isPublicProfilePath("/profile")).toBe(false);
  expect(isPublicProfilePath("/settings/profile")).toBe(false);
});

it("sends a QR link's redirect with no referrer, and every other header as on the rest of the app", () => {
  const { "Referrer-Policy": referrer, ...rest } = entryLinkSecurityHeaders(env);
  expect(referrer).toBe("no-referrer");
  const { "Referrer-Policy": usual, ...others } = securityHeaders(env);
  expect(usual).toBe("strict-origin-when-cross-origin");
  expect(rest).toEqual(others);
  expect(isEntryLinkPath(entryLinkPath("k7m2pq"))).toBe(true);
  for (const path of ["/q", "/q/", "/q/k7m2pq/more", "/qr/k7m2pq", "/settings/qrcode"]) expect(isEntryLinkPath(path), path).toBe(false);
});

// AUDIT-008: `script-src 'self' 'unsafe-inline'` would not stop an injected
// script. The nonce replaces it, in three steps, so a missed inline script is
// a line in the console before it is a blank screen.
const withNonce = { ...env, CSP_SCRIPT_NONCE: "true" };
const enforcing = { ...withNonce, CSP_SCRIPT_NONCE_ENFORCED: "true" };
const scriptDirectives = (policy: string | undefined) => (policy ?? "").split("; ").filter((directive) => directive.startsWith("script-src"));
const todaysScripts = scriptDirectives(securityHeaders(env)["Content-Security-Policy"])[0]!;

it("keeps today's policy, and sends nothing extra, until a deployment asks for the nonce", () => {
  const headers = securityHeaders(env, "n0nce");

  expect(headers["Content-Security-Policy"]).toBe(securityHeaders(env)["Content-Security-Policy"]);
  expect(scriptDirectives(headers["Content-Security-Policy"])).toEqual([expect.stringMatching(/^script-src 'self' 'unsafe-inline' /)]);
  expect(headers).not.toHaveProperty(CSP_REPORT_ONLY_HEADER);
  expect(getScriptNonceFromHeader(headers["Content-Security-Policy"]!)).toBeUndefined();
});

it("reports on the strict policy first, and blocks nothing it didn't block before", () => {
  const headers = securityHeaders(withNonce, "n0nce");
  const [script, elements, handlers, ...more] = scriptDirectives(headers["Content-Security-Policy"]);

  // The report is the strict policy, except that it stays quiet about eval, which every step refuses.
  expect(scriptDirectives(headers[CSP_REPORT_ONLY_HEADER])).toEqual([todaysScripts.replace("'unsafe-inline'", "'nonce-n0nce' 'strict-dynamic' 'unsafe-eval'")]);
  expect(headers[CSP_REPORT_ONLY_HEADER]!.replace(" 'unsafe-eval'", "")).toBe(securityHeaders(enforcing, "n0nce")["Content-Security-Policy"]);
  expect(headers["Content-Security-Policy"]).not.toContain("'unsafe-eval'");
  // Every script and every handler is asked about what today's policy says...
  expect(elements).toBe(todaysScripts.replace("script-src ", "script-src-elem "));
  expect(handlers).toBe("script-src-attr 'unsafe-inline'");
  expect(more).toEqual([]);
  // ...and script-src, which is left with eval, names the nonce for Next to find.
  expect(script).toBe(todaysScripts.replace("'unsafe-inline'", "'unsafe-inline' 'nonce-n0nce'"));
  // Apart from the script directives, the enforced policy is today's.
  expect(headers["Content-Security-Policy"]!.replace(`${script}; ${elements}; ${handlers}`, todaysScripts)).toBe(securityHeaders(env)["Content-Security-Policy"]);
});

it("enforces the strict policy and stops reporting once the second setting is on", () => {
  const headers = securityHeaders(enforcing, "n0nce");

  expect(scriptDirectives(headers["Content-Security-Policy"])).toEqual([todaysScripts.replace("'unsafe-inline'", "'nonce-n0nce' 'strict-dynamic'")]);
  expect(headers["Content-Security-Policy"]).not.toContain("'unsafe-inline' https://");
  expect(headers).not.toHaveProperty(CSP_REPORT_ONLY_HEADER);
});

// Next copies the proxy's response headers over the request's, then reads the
// nonce from the enforced policy, and from the report-only one only when no
// policy is enforced. A nonce that is only in the report-only header never
// reaches a script, and the report then names every script on the page.
it.each([["reported on", withNonce], ["enforced", enforcing]])("names the nonce where Next looks for it while the strict policy is %s", (_step, settings) => {
  for (const headers of [securityHeaders(settings, "n0nce"), embeddableSecurityHeaders(settings, "n0nce"), publicProfileSecurityHeaders(settings, "n0nce"), entryLinkSecurityHeaders(settings, "n0nce")]) {
    expect(getScriptNonceFromHeader(headers["Content-Security-Policy"]!)).toBe("n0nce");
  }
});

it("never nonces a policy without one, however the settings are set", () => {
  expect(securityHeaders(enforcing)).toEqual(securityHeaders(env));
  expect(securityHeaders(withNonce)).toEqual(securityHeaders(env));
});

it("keeps eval for development in every step, where Next's own tools need it", () => {
  const development = { NODE_ENV: "development" } as Record<string, string | undefined>;
  for (const settings of [development, { ...development, CSP_SCRIPT_NONCE: "true" }, { ...development, CSP_SCRIPT_NONCE: "true", CSP_SCRIPT_NONCE_ENFORCED: "true" }]) {
    const headers = securityHeaders(settings, "n0nce");
    expect(scriptDirectives(headers["Content-Security-Policy"])[0]).toContain("'unsafe-eval'");
  }
  expect(scriptDirectives(securityHeaders(enforcing, "n0nce")["Content-Security-Policy"])[0]).not.toContain("'unsafe-eval'");
});

it("rewrites both policies for an embeddable or a profile route, so the two never disagree", () => {
  const embeddable = embeddableSecurityHeaders(withNonce, "n0nce");
  expect(embeddable["Content-Security-Policy"]).toContain("frame-ancestors *");
  expect(embeddable[CSP_REPORT_ONLY_HEADER]).toContain("frame-ancestors *");

  const profile = publicProfileSecurityHeaders(withNonce, "n0nce");
  expect(profile["Content-Security-Policy"]).toContain("https://www.google.com");
  expect(profile[CSP_REPORT_ONLY_HEADER]).toContain("https://www.google.com");
});

it("leaves the brand logo's policy alone, which allows no script at all", () => {
  const headers = brandLogoSecurityHeaders(withNonce);

  expect(headers["Content-Security-Policy"]).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
  expect(headers).not.toHaveProperty(CSP_REPORT_ONLY_HEADER);
});

it("reads the three states from the two settings", () => {
  expect(cspScriptNonceState(env)).toBe("off");
  expect(cspScriptNonceState(withNonce)).toBe("reporting");
  expect(cspScriptNonceState(enforcing)).toBe("enforced");
  expect(cspScriptNonceState({ ...env, CSP_SCRIPT_NONCE_ENFORCED: "true" })).toBe("off");
});
