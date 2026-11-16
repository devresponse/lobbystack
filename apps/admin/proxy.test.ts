import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";
import { config, proxy } from "./proxy";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("skips known assets but retains proxy checks for application paths with extensions", () => {
  for (const url of ["/locales/en/auth.json", "/brand/logo-icon.svg", "/_next/static/chunk.js", "/favicon.ico"]) {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false);
  }
  for (const url of ["/api/contacts/contact.svg", "/embed.js", "/embed/key.svg", "/en/reset-password/token.txt", "/en/login"]) {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
  }
});

it("rejects cross-origin API mutations even when a dynamic identifier has an extension", () => {
  const response = proxy(new NextRequest("http://localhost:3210/api/contacts/contact.svg", { method: "PATCH", headers: { origin: "https://untrusted.invalid" } }));
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

it("lets the logo route cache its versioned image and serves it without script", () => {
  const logo = proxy(new NextRequest("http://localhost:3210/api/branding/logo?v=abc"));
  expect(logo.headers.get("cache-control")).toBeNull();
  expect(logo.headers.get("content-security-policy")).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
  expect(logo.headers.get("x-content-type-options")).toBe("nosniff");
  const branding = proxy(new NextRequest("http://localhost:3210/api/branding"));
  expect(branding.headers.get("cache-control")).toBe("private, no-store");
  expect(branding.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  const save = proxy(new NextRequest("http://localhost:3210/api/branding/initial", { method: "POST", headers: { origin: "https://untrusted.invalid" } }));
  expect(save.status).toBe(403);
});

it("guards the widget-keys admin route while leaving the public widget API open to other origins", () => {
  const adminRoute = proxy(new NextRequest("http://localhost:3210/api/widget-keys", { method: "POST", headers: { origin: "https://untrusted.invalid" } }));
  expect(adminRoute.status).toBe(403);
  const publicRoute = proxy(new NextRequest("http://localhost:3210/api/widget/session", { method: "POST", headers: { origin: "https://customer.example" } }));
  expect(publicRoute.status).toBe(200);
});

it("lets API clients PUT to signed local storage URLs without an Origin, and still guards the dashboard upload route", () => {
  const signedUpload = proxy(new NextRequest("http://localhost:3210/api/storage/local?token=signed", { method: "PUT" }));
  expect(signedUpload.status).toBe(200);
  const dashboardUpload = proxy(new NextRequest("http://localhost:3210/api/uploads", { method: "POST", headers: { origin: "https://untrusted.invalid" } }));
  expect(dashboardUpload.status).toBe(403);
  // Only the signed upload route itself is exempt, not routes whose paths start the same way.
  const lookalike = proxy(new NextRequest("http://localhost:3210/api/storage/local-files", { method: "PUT", headers: { origin: "https://untrusted.invalid" } }));
  expect(lookalike.status).toBe(403);
});

it("overwrites supplied locale headers and tolerates malformed cookies", () => {
  const response = proxy(new NextRequest("http://localhost:3210/fr/login", { headers: { cookie: "lobbystack.locale=%E0%A4%A", "accept-language": "en", "x-lobbystack-locale": "en", "x-lobbystack-pathname": "/settings" } }));
  expect(response.headers.get("x-middleware-request-x-lobbystack-locale")).toBe("fr");
  expect(response.headers.get("x-middleware-request-x-lobbystack-pathname")).toBe("/fr/login");
  expect(response.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=3600");
  expect(response.headers.get("content-language")).toBe("fr");
  expect(response.headers.get("vary")).toBe("Accept-Encoding");
});

it("serves Spanish and Serbian public pages with their language tags", () => {
  const spanish = proxy(new NextRequest("http://localhost:3210/es/login"));
  expect(spanish.headers.get("x-middleware-request-x-lobbystack-locale")).toBe("es");
  expect(spanish.headers.get("content-language")).toBe("es");

  const serbian = proxy(new NextRequest("http://localhost:3210/sr/signup"));
  expect(serbian.headers.get("x-middleware-request-x-lobbystack-locale")).toBe("sr");
  // Serbian pages are written in Latin script only.
  expect(serbian.headers.get("content-language")).toBe("sr-Latn");

  const negotiated = proxy(new NextRequest("http://localhost:3210/login", { headers: { "accept-language": "sr-RS,sr;q=0.9,en;q=0.4" } }));
  expect(negotiated.status).toBe(308);
  expect(negotiated.headers.get("location")).toBe("http://localhost:3210/sr/login");

  const explicit = proxy(new NextRequest("http://localhost:3210/fr/login?lng=es"));
  expect(explicit.headers.get("location")).toBe("http://localhost:3210/es/login");
  expect(explicit.headers.get("set-cookie")).toContain("lobbystack.locale=es");
});

it("opens the website widget's chat in the language its loader names, without saving it as the visitor's", () => {
  const chat = proxy(new NextRequest("http://localhost:3210/embed/wk_live_key?color=%230f766e&locale=fr", { headers: { cookie: "lobbystack.locale=es", "accept-language": "en-US" } }));
  expect(chat.headers.get("x-middleware-request-x-lobbystack-locale")).toBe("fr");
  expect(chat.headers.get("set-cookie")).toBeNull();

  // A widget whose settings set no language, or an older loader, names none,
  // and a language the chat doesn't offer is ignored: the chat starts in the visitor's.
  for (const url of ["/embed/wk_live_key?color=%230f766e", "/embed/wk_live_key?locale=de"]) {
    const older = proxy(new NextRequest(`http://localhost:3210${url}`, { headers: { "accept-language": "es-MX" } }));
    expect(older.headers.get("x-middleware-request-x-lobbystack-locale"), url).toBe("es");
  }
  // Only the widget's chat takes the language from its address.
  const dashboard = proxy(new NextRequest("http://localhost:3210/calls?locale=fr", { headers: { "accept-language": "en-US" } }));
  expect(dashboard.headers.get("x-middleware-request-x-lobbystack-locale")).toBe("en");
});

it("redirects legacy public URLs to a canonical locale while preserving safe query values", () => {
  const explicit = proxy(new NextRequest("http://localhost:3210/login?lng=fr&returnTo=%2Fsettings&campaign=fall", {
    headers: { cookie: "lobbystack.locale=en", "accept-language": "en-US" },
  }));
  expect(explicit.status).toBe(308);
  expect(explicit.headers.get("location")).toBe("http://localhost:3210/fr/login?returnTo=%2Fsettings&campaign=fall");
  expect(explicit.headers.get("set-cookie")).toContain("lobbystack.locale=fr");
  expect(explicit.headers.get("cache-control")).toBe("private, no-store");

  const fromCookie = proxy(new NextRequest("http://localhost:3210/signup", {
    headers: { cookie: "lobbystack.locale=fr", "accept-language": "en-US" },
  }));
  expect(fromCookie.headers.get("location")).toBe("http://localhost:3210/fr/signup");

  const fromHeader = proxy(new NextRequest("http://localhost:3210/forgot-password", {
    headers: { "accept-language": "fr-CA,fr;q=0.9" },
  }));
  expect(fromHeader.headers.get("location")).toBe("http://localhost:3210/fr/forgot-password");
});

it("serves help pages in the languages that have help, and sends the others to English", () => {
  const english = proxy(new NextRequest("http://localhost:3210/en/help/rules", { headers: { cookie: "lobbystack.locale=fr" } }));
  expect(english.status).toBe(200);
  expect(english.headers.get("x-middleware-request-x-lobbystack-locale")).toBe("en");
  expect(english.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=3600");
  const markdown = proxy(new NextRequest("http://localhost:3210/en/help.md"));
  expect(markdown.status).toBe(200);
  expect(markdown.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=3600");
  expect(proxy(new NextRequest("http://localhost:3210/fr/help.md")).headers.get("location")).toBe("http://localhost:3210/en/help.md");
  expect(proxy(new NextRequest("http://localhost:3210/help.md")).headers.get("location")).toBe("http://localhost:3210/en/help.md");

  // Until a language has its own help, its address answers with the English page, for now.
  const french = proxy(new NextRequest("http://localhost:3210/fr/help/rules?ref=app"));
  expect(french.status).toBe(307);
  expect(french.headers.get("location")).toBe("http://localhost:3210/en/help/rules?ref=app");
  expect(french.headers.get("cache-control")).toBe("private, no-store");
  expect(proxy(new NextRequest("http://localhost:3210/sr/help")).headers.get("location")).toBe("http://localhost:3210/en/help");

  // An address without a language goes to help in a language that has it, whatever the reader's.
  const legacy = proxy(new NextRequest("http://localhost:3210/help/rules", { headers: { "accept-language": "fr-CA,fr;q=0.9" } }));
  expect(legacy.status).toBe(308);
  expect(legacy.headers.get("location")).toBe("http://localhost:3210/en/help/rules");
  const chosen = proxy(new NextRequest("http://localhost:3210/en/help?lng=es"));
  expect(chosen.headers.get("location")).toBe("http://localhost:3210/en/help");

  // A language named in a help address is never saved as the reader's own.
  expect(chosen.headers.get("set-cookie")).toBeNull();
  for (const url of ["/fr/help?lng=es", "/help?lng=es", "/fr/help/rules?lng=fr", "/help.md?lng=fr"]) {
    const response = proxy(new NextRequest(`http://localhost:3210${url}`));
    expect(response.headers.get("location"), url).toMatch(/^http:\/\/localhost:3210\/en\/help/);
    expect(response.headers.get("set-cookie"), url).toBeNull();
  }
});

it("keeps sensitive and dynamic responses private while caching fixed public pages", () => {
  for (const url of [
    "/en/reset-password/token-value",
    "/fr/verify-email?token=private",
    "/api/dashboard",
    "/api/realtime",
    "/embed/widget-key",
    "/agent",
    "/en/login?token=private",
  ]) {
    const response = proxy(new NextRequest(`http://localhost:3210${url}`));
    expect(response.headers.get("cache-control"), url).toContain("private");
    expect(response.headers.get("cache-control"), url).toContain("no-store");
  }

  // Streams must reach the browser as they're written, so proxies may not compress or buffer them.
  for (const url of ["/api/realtime", "/api/widget/chat", "/api/widget/stream"]) {
    expect(proxy(new NextRequest(`http://localhost:3210${url}`)).headers.get("cache-control"), url).toBe("private, no-cache, no-store, no-transform");
  }

  const publicResponse = proxy(new NextRequest("http://localhost:3210/en/signup?campaign=fall"));
  expect(publicResponse.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=3600");
  expect(publicResponse.headers.get("content-language")).toBe("en");
  expect(publicResponse.headers.get("vary")).toBe("Accept-Encoding");
});

it("sends a QR link's redirect with no referrer, and the usual policy everywhere else", () => {
  const link = proxy(new NextRequest("http://localhost:3210/q/k7m2pq"));
  expect(link.headers.get("referrer-policy")).toBe("no-referrer");
  expect(link.headers.get("x-frame-options")).toBe("DENY");
  expect(link.headers.get("x-content-type-options")).toBe("nosniff");
  for (const path of ["/settings/qrcode", "/profile/acme-dental"]) {
    expect(proxy(new NextRequest(`http://localhost:3210${path}`)).headers.get("referrer-policy"), path).toBe("strict-origin-when-cross-origin");
  }
});

it("serves a business's public page privately in the visitor's language, with a policy that allows its map", () => {
  const page = proxy(new NextRequest("http://localhost:3210/profile/acme-dental", { headers: { "accept-language": "es-MX,es;q=0.9" } }));
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("private, no-store");
  expect(page.headers.get("x-middleware-request-x-lobbystack-locale")).toBe("es");
  expect(page.headers.get("content-security-policy")).toContain("https://www.google.com");
  expect(page.headers.get("x-frame-options")).toBe("DENY");
  expect(proxy(new NextRequest("http://localhost:3210/settings/profile")).headers.get("content-security-policy")).not.toContain("https://www.google.com");

  // Its language links save the visitor's pick, as ?lng= does everywhere else.
  const french = proxy(new NextRequest("http://localhost:3210/profile/acme-dental?lng=fr"));
  expect(french.status).toBe(200);
  expect(french.headers.get("x-middleware-request-x-lobbystack-locale")).toBe("fr");
  expect(french.cookies.get("lobbystack.locale")?.value).toBe("fr");
});

it("fails closed for API requests during maintenance while leaving health reads available", () => {
  vi.stubEnv("LOBBYSTACK_MAINTENANCE_MODE", "true");

  const mutation = proxy(new NextRequest("http://localhost:3210/api/contacts", { method: "POST" }));
  expect(mutation.status).toBe(503);
  expect(mutation.headers.get("retry-after")).toBe("60");
  expect(mutation.headers.get("cache-control")).toBe("no-store");

  expect(proxy(new NextRequest("http://localhost:3210/api/health/live")).status).toBe(200);
  expect(proxy(new NextRequest("http://localhost:3210/api/dashboard")).status).toBe(503);
});

it("rejects webhooks before their handlers can acknowledge events during maintenance", () => {
  vi.stubEnv("LOBBYSTACK_MAINTENANCE_MODE", "true");

  const response = proxy(new NextRequest("http://localhost:3210/api/webhooks/twilio/sms", { method: "POST" }));
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("60");
});

// The access gate: with PROTECTION_TOKEN set, a test deployment answers only
// to a browser that opened the access link (docs/features/access-gate.md).
const PROTECTION_TOKEN = "protection-token-fixture-0123456789-abcdef";
const NOINDEX = "noindex, nofollow";

function accessCookie(origin = "http://localhost:3210"): string {
  const granted = proxy(new NextRequest(`${origin}/login?access=${PROTECTION_TOKEN}`));
  const cookie = granted.cookies.getAll()[0]!;
  return `${cookie.name}=${cookie.value}`;
}

it("changes nothing while PROTECTION_TOKEN is unset or empty", () => {
  for (const value of [undefined, "", "  "]) {
    vi.stubEnv("PROTECTION_TOKEN", value);
    const page = proxy(new NextRequest(`http://localhost:3210/fr/login?access=${PROTECTION_TOKEN}`, { headers: { "x-protection-token": "kept" } }));
    expect(page.status).toBe(200);
    expect(page.headers.get("x-middleware-next")).toBe("1");
    expect(page.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=3600");
    expect(page.headers.get("x-robots-tag")).toBeNull();
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(page.headers.get("x-middleware-request-x-protection-token")).toBe("kept");
    expect(proxy(new NextRequest("http://localhost:3210/api/branding/logo?v=abc")).headers.get("cache-control")).toBeNull();
    expect(proxy(new NextRequest("http://localhost:3210/api/widget/session", { method: "POST" })).headers.get("x-robots-tag")).toBeNull();
  }
});

it("answers a stranger the same bare 404 at every closed address", async () => {
  vi.stubEnv("PROTECTION_TOKEN", PROTECTION_TOKEN);
  const closed: Array<[string, string]> = [
    ["GET", "/"],
    ["GET", "/login"],
    ["GET", "/fr/login"],
    ["GET", "/en/pricing"],
    ["GET", "/dashboard"],
    ["GET", "/profile/acme-dental"],
    ["GET", "/q/k7m2pq"],
    ["GET", "/en/help"],
    ["GET", "/no-such-page"],
    ["GET", "/api/auth/get-session"],
    ["POST", "/api/auth/sign-in/email"],
    ["GET", "/api/auth/oauth2/authorize"],
    ["GET", "/api/branding/logo?v=abc"],
    ["POST", "/api/widget-keys"],
    ["POST", "/api/contacts"],
    ["OPTIONS", "/api/contacts"],
    ["HEAD", "/login"],
    // The token opens a page load only: a script sends the header.
    ["POST", `/api/contacts?access=${PROTECTION_TOKEN}`],
  ];
  for (const [method, path] of closed) {
    const response = proxy(new NextRequest(`http://localhost:3210${path}`, { method, headers: { "accept-language": "fr" } }));
    expect(response.status, `${method} ${path}`).toBe(404);
    expect(response.headers.get("x-middleware-next"), path).toBeNull();
    expect(response.headers.get("location"), path).toBeNull();
    expect(response.headers.get("set-cookie"), path).toBeNull();
    expect(response.headers.get("cache-control"), path).toBe("no-store");
    expect(response.headers.get("x-robots-tag"), path).toBe(NOINDEX);
    expect(response.headers.get("content-type"), path).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
    expect(await response.text(), path).toBe("Not found");
  }
});

it("exchanges the token in an address for the cookie and takes it out of the address", () => {
  vi.stubEnv("PROTECTION_TOKEN", PROTECTION_TOKEN);
  const granted = proxy(new NextRequest(`http://localhost:3210/login?access=${PROTECTION_TOKEN}&returnTo=%2Fsettings`));
  expect(granted.status).toBe(303);
  expect(granted.headers.get("location")).toBe("http://localhost:3210/login?returnTo=%2Fsettings");
  expect(granted.headers.get("cache-control")).toBe("no-store");
  expect(granted.headers.get("x-robots-tag")).toBe(NOINDEX);
  expect(granted.headers.get("x-frame-options")).toBe("DENY");
  const setCookie = granted.headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(/^lobbystack-access=v1\.\d+\.[A-Za-z0-9_-]{43}; /);
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Max-Age=2592000");
  expect(setCookie).not.toContain(PROTECTION_TOKEN);

  // Over HTTPS, which Railway's proxy reports, the cookie is this host's alone.
  const secure = proxy(new NextRequest(`https://test.example.test/?access=${PROTECTION_TOKEN}`));
  expect(secure.headers.get("location")).toBe("https://test.example.test/");
  expect(secure.headers.get("set-cookie")).toMatch(/^__Host-lobbystack-access=v1\..*; Secure/);
  expect(secure.headers.get("set-cookie")).not.toContain("Domain");
});

it("lets a browser with the cookie in, and keeps every answer to it out of shared caches", () => {
  vi.stubEnv("PROTECTION_TOKEN", PROTECTION_TOKEN);
  const cookie = accessCookie();

  const page = proxy(new NextRequest("http://localhost:3210/fr/login", { headers: { cookie } }));
  expect(page.status).toBe(200);
  expect(page.headers.get("x-middleware-next")).toBe("1");
  expect(page.headers.get("x-middleware-request-x-lobbystack-locale")).toBe("fr");
  expect(page.headers.get("content-language")).toBe("fr");
  // Without the gate this page and the logo are stored by shared caches, which would hand them to a stranger.
  expect(page.headers.get("cache-control")).toBe("private, no-store");
  expect(proxy(new NextRequest("http://localhost:3210/api/branding/logo?v=abc", { headers: { cookie } })).headers.get("cache-control")).toBe("private, no-store");
  expect(page.headers.get("x-robots-tag")).toBe(NOINDEX);
  expect(page.headers.get("set-cookie")).toBeNull();

  // The rest of the proxy runs as before: language redirects and the origin check on API changes.
  const legacy = proxy(new NextRequest("http://localhost:3210/login?returnTo=%2Fsettings", { headers: { cookie, "accept-language": "fr" } }));
  expect(legacy.status).toBe(308);
  expect(legacy.headers.get("location")).toBe("http://localhost:3210/fr/login?returnTo=%2Fsettings");
  expect(legacy.headers.get("x-robots-tag")).toBe(NOINDEX);
  expect(proxy(new NextRequest("http://localhost:3210/api/contacts", { method: "POST", headers: { cookie, origin: "https://untrusted.invalid" } })).status).toBe(403);
  expect(proxy(new NextRequest("http://localhost:3210/api/contacts", { method: "POST", headers: { cookie, origin: "http://localhost:3210" } })).status).toBe(200);

  // A cookie from before the token changed opens nothing.
  vi.stubEnv("PROTECTION_TOKEN", "another-protection-token-fixture-9876543210");
  expect(proxy(new NextRequest("http://localhost:3210/fr/login", { headers: { cookie } })).status).toBe(404);
});

it("leaves the routes other services call open, with their answers as they were", () => {
  vi.stubEnv("PROTECTION_TOKEN", PROTECTION_TOKEN);
  const open: Array<[string, string]> = [
    ["POST", "/api/webhooks/twilio/sms"],
    ["POST", "/api/webhooks/stripe"],
    ["GET", "/api/health/live"],
    ["GET", "/api/health/ready"],
    ["GET", "/embed.js"],
    ["GET", "/embed/wk_live_key"],
    ["POST", "/api/widget/session"],
    ["OPTIONS", "/api/widget/chat"],
    ["POST", "/api/voice/live/session"],
    ["POST", "/api/voice/live/session/end"],
    ["GET", "/api/v1/businesses"],
    ["POST", "/api/mcp"],
    ["GET", "/.well-known/oauth-protected-resource/api/mcp"],
    ["POST", "/api/auth/oauth2/token"],
    ["PUT", "/api/storage/local?token=signed"],
    ["GET", "/api/internal/finance/export"],
    ["GET", "/api/internal/fleet?token=its-own-token&worker=2"],
  ];
  for (const [method, path] of open) {
    const response = proxy(new NextRequest(`http://localhost:3210${path}`, { method, headers: { origin: "https://customer.example" } }));
    expect(response.status, `${method} ${path}`).toBe(200);
    expect(response.headers.get("x-middleware-next"), path).toBe("1");
    expect(response.headers.get("x-robots-tag"), path).toBe(NOINDEX);
    expect(response.headers.get("set-cookie"), path).toBeNull();
  }
  // Their caching is their own: the loader stays cacheable, the chat's stream stays unbuffered.
  expect(proxy(new NextRequest("http://localhost:3210/embed.js")).headers.get("cache-control")).toBeNull();
  expect(proxy(new NextRequest("http://localhost:3210/api/widget/stream")).headers.get("cache-control")).toBe("private, no-cache, no-store, no-transform");
  expect(proxy(new NextRequest("http://localhost:3210/embed/wk_live_key")).headers.get("content-security-policy")).toContain("frame-ancestors *");
  // The widget's chat still opens in the language its loader names.
  expect(proxy(new NextRequest("http://localhost:3210/embed/wk_live_key?locale=fr")).headers.get("x-middleware-request-x-lobbystack-locale")).toBe("fr");
  // A script that sends the gate's header with every request hands its token to no open route either.
  const withHeader = proxy(new NextRequest("http://localhost:3210/api/v1/businesses", { headers: { "x-protection-token": PROTECTION_TOKEN, "x-request-id": "kept" } }));
  expect(withHeader.status).toBe(200);
  expect(withHeader.headers.get("x-middleware-override-headers")?.split(",")).toContain("x-request-id");
  expect(withHeader.headers.get("x-middleware-override-headers")?.split(",")).not.toContain("x-protection-token");
  expect([...withHeader.headers.values()].join("\n")).not.toContain(PROTECTION_TOKEN);
});

it("lets a script in by the header, and doesn't pass its token on to the page", () => {
  vi.stubEnv("PROTECTION_TOKEN", PROTECTION_TOKEN);
  const response = proxy(new NextRequest("http://localhost:3210/api/dashboard", { headers: { "x-protection-token": PROTECTION_TOKEN, "x-request-id": "kept" } }));
  expect(response.status).toBe(200);
  expect(response.headers.get("x-middleware-next")).toBe("1");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  const passedOn = response.headers.get("x-middleware-override-headers")?.split(",") ?? [];
  expect(passedOn).toContain("x-request-id");
  expect(passedOn).not.toContain("x-protection-token");
  expect(response.headers.get("x-middleware-request-x-protection-token")).toBeNull();
  expect([...response.headers.values()].join("\n")).not.toContain(PROTECTION_TOKEN);
});

it("answers a stranger's 404 before maintenance mode, which still answers everyone the gate lets through", () => {
  vi.stubEnv("PROTECTION_TOKEN", PROTECTION_TOKEN);
  const cookie = accessCookie();
  vi.stubEnv("LOBBYSTACK_MAINTENANCE_MODE", "true");

  expect(proxy(new NextRequest("http://localhost:3210/api/dashboard")).status).toBe(404);
  expect(proxy(new NextRequest("http://localhost:3210/api/contacts", { method: "POST" })).status).toBe(404);
  const signedIn = proxy(new NextRequest("http://localhost:3210/api/dashboard", { headers: { cookie } }));
  expect(signedIn.status).toBe(503);
  expect(signedIn.headers.get("retry-after")).toBe("60");
  expect(signedIn.headers.get("x-robots-tag")).toBe(NOINDEX);
  // Open routes meet maintenance mode exactly as they do without the gate.
  expect(proxy(new NextRequest("http://localhost:3210/api/webhooks/twilio/sms", { method: "POST" })).status).toBe(503);
  expect(proxy(new NextRequest("http://localhost:3210/api/health/live")).status).toBe(200);
  // The access link still works, so a tester can see the maintenance answer for themselves.
  expect(proxy(new NextRequest(`http://localhost:3210/login?access=${PROTECTION_TOKEN}`)).status).toBe(303);
});

it("warns about a token that doesn't match, once a minute at most and never with a token", () => {
  vi.useFakeTimers({ now: Date.now() + 60 * 60 * 1000 });
  vi.stubEnv("PROTECTION_TOKEN", PROTECTION_TOKEN);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const wrong = "an-access-token-from-before-it-was-changed";
  const lines = () => warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("access_gate.wrong_token"));

  expect(proxy(new NextRequest(`http://localhost:3210/login?access=${wrong}`)).status).toBe(404);
  expect(lines()).toHaveLength(1);
  expect(JSON.parse(lines()[0]!)).toMatchObject({ level: "warn", message: "access_gate.wrong_token", via: "query" });
  expect(lines()[0]).not.toContain(wrong);
  expect(lines()[0]).not.toContain(PROTECTION_TOKEN);

  // A script guessing tokens gets the same 404 and no line of its own.
  expect(proxy(new NextRequest("http://localhost:3210/api/dashboard", { headers: { "x-protection-token": wrong } })).status).toBe(404);
  expect(lines()).toHaveLength(1);
  // A request with no token at all is never a warning.
  vi.advanceTimersByTime(61_000);
  expect(proxy(new NextRequest("http://localhost:3210/login")).status).toBe(404);
  expect(lines()).toHaveLength(1);
  expect(proxy(new NextRequest("http://localhost:3210/api/dashboard", { headers: { "x-protection-token": wrong } })).status).toBe(404);
  expect(lines()).toHaveLength(2);
  expect(JSON.parse(lines()[1]!)).toMatchObject({ message: "access_gate.wrong_token", via: "header", notLogged: 1 });
});

// AUDIT-008: Next puts the nonce on the scripts it writes by reading it out of
// the request's policy, after copying this response's headers over the
// request's (resolve-routes.ts, parse-request-headers.ts). So what Next finds
// is whatever the proxy enforces, and only without one, what it reports on.
const requestOverride = (response: Response, name: string) => response.headers.get(`x-middleware-request-${name}`);
const nonceNextReads = (response: Response): string | undefined => {
  const policy = response.headers.get("content-security-policy") || response.headers.get("content-security-policy-report-only");
  return policy ? getScriptNonceFromHeader(policy) : undefined;
};

it("sends no nonce and today's policy until a deployment turns the setting on", () => {
  const response = proxy(new NextRequest("http://localhost:3210/calls"));

  expect(response.headers.get("content-security-policy")).toContain("script-src 'self' 'unsafe-inline'");
  expect(response.headers.get("content-security-policy-report-only")).toBeNull();
  expect(requestOverride(response, "x-lobbystack-nonce")).toBeNull();
  expect(nonceNextReads(response)).toBeUndefined();
});

it("gives each request its own nonce, and hands it to the page and to Next", () => {
  vi.stubEnv("CSP_SCRIPT_NONCE", "true");

  const first = proxy(new NextRequest("http://localhost:3210/calls"));
  const second = proxy(new NextRequest("http://localhost:3210/calls"));
  const nonce = requestOverride(first, "x-lobbystack-nonce");

  expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  expect(requestOverride(second, "x-lobbystack-nonce")).not.toBe(nonce);
  expect(first.headers.get("content-security-policy-report-only")).toContain(`'nonce-${nonce}' 'strict-dynamic'`);
  // While it only reports, scripts and handlers are still asked about 'unsafe-inline'...
  expect(first.headers.get("content-security-policy")).toContain("script-src-elem 'self' 'unsafe-inline'");
  expect(first.headers.get("content-security-policy")).toContain("script-src-attr 'unsafe-inline'");
  // ...and Next still finds the nonce, or the report would name every script it wrote.
  expect(nonceNextReads(first)).toBe(nonce);
  expect(requestOverride(first, "content-security-policy")).toBe(first.headers.get("content-security-policy"));
});

it("enforces the strict policy once the second setting is on", () => {
  vi.stubEnv("CSP_SCRIPT_NONCE", "true");
  vi.stubEnv("CSP_SCRIPT_NONCE_ENFORCED", "true");

  const response = proxy(new NextRequest("http://localhost:3210/calls"));
  const nonce = requestOverride(response, "x-lobbystack-nonce");

  expect(response.headers.get("content-security-policy")).toContain(`'nonce-${nonce}' 'strict-dynamic'`);
  expect(response.headers.get("content-security-policy")).not.toContain("'unsafe-inline' https://");
  expect(response.headers.get("content-security-policy-report-only")).toBeNull();
  expect(nonceNextReads(response)).toBe(nonce);
  expect(requestOverride(response, "content-security-policy")).toBe(response.headers.get("content-security-policy"));
});

// The sign-in pages and the help center are written at build time, so there is
// no request in which Next could put a nonce on their scripts. Under the strict
// policy every script on them would be blocked: nobody could sign in.
it.each(["/en/login", "/fr/signup", "/es/forgot-password", "/sr/accept-invite", "/en/help", "/en/help/rules"])(
  "leaves %s, which is built ahead of time, on the policy it had, whatever the settings say",
  (path) => {
    vi.stubEnv("CSP_SCRIPT_NONCE", "true");
    vi.stubEnv("CSP_SCRIPT_NONCE_ENFORCED", "true");

    const response = proxy(new NextRequest(`http://localhost:3210${path}`));

    expect(response.headers.get("content-security-policy")).toContain("script-src 'self' 'unsafe-inline'");
    expect(response.headers.get("content-security-policy")).not.toContain("nonce-");
    expect(response.headers.get("content-security-policy-report-only")).toBeNull();
    expect(requestOverride(response, "x-lobbystack-nonce")).toBeNull();
    expect(requestOverride(response, "content-security-policy")).toBeNull();
  },
);

it("reports on nothing for a page built ahead of time, so its console stays quiet while the rest is watched", () => {
  vi.stubEnv("CSP_SCRIPT_NONCE", "true");

  const response = proxy(new NextRequest("http://localhost:3210/en/login"));

  expect(response.headers.get("content-security-policy-report-only")).toBeNull();
  expect(requestOverride(response, "x-lobbystack-nonce")).toBeNull();
});

// The widget's loader caches itself for every site that embeds it (its route
// sets the header, not the proxy), so it is the other answer that gets none.
it("puts no nonce on the widget's loader, a script file that shared caches store", () => {
  vi.stubEnv("CSP_SCRIPT_NONCE", "true");
  vi.stubEnv("CSP_SCRIPT_NONCE_ENFORCED", "true");

  const response = proxy(new NextRequest("http://localhost:3210/embed.js"));

  expect(response.headers.get("content-security-policy")).not.toContain("nonce-");
  expect(response.headers.get("content-security-policy-report-only")).toBeNull();
  expect(requestOverride(response, "x-lobbystack-nonce")).toBeNull();
  // The chat it opens is a page rendered for one visitor, and does get one.
  expect(proxy(new NextRequest("http://localhost:3210/embed/wk_live_abc")).headers.get("content-security-policy")).toContain("'strict-dynamic'");
});

// A nonce is one request's. A response a shared cache may hand to the next
// visitor must never carry one, in the header that enforces or the one that reports.
it.each(["/en/login", "/en/help", "/calls", "/profile/acme", "/embed/wk_live_abc", "/api/calls", "/"])(
  "never puts a nonce on an answer a shared cache may store: %s",
  (path) => {
    vi.stubEnv("CSP_SCRIPT_NONCE", "true");
    vi.stubEnv("CSP_SCRIPT_NONCE_ENFORCED", "true");

    const response = proxy(new NextRequest(`http://localhost:3210${path}`));
    const shared = (response.headers.get("cache-control") ?? "").includes("public");
    const carriesNonce = (response.headers.get("content-security-policy") ?? "").includes("nonce-");

    expect(shared && carriesNonce, `${path} is ${response.headers.get("cache-control")}`).toBe(false);
    // And the pages rendered for one request are the ones that get it.
    if (!shared && !path.startsWith("/api/")) expect(carriesNonce, path).toBe(true);
  },
);
