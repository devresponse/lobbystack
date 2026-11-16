import { readFile } from "node:fs/promises";
import path from "node:path";

import { isCanonicalPublicPath } from "../apps/admin/src/lib/locale-path";

const locales = ["en", "fr", "es", "sr"] as const;
const publicRoutes = [
  "accept-invite",
  "claim-demo",
  "confirm-email-change",
  "demo",
  "forgot-password",
  "login",
  "reset-password",
  "signup",
] as const;

const manifestPath = path.resolve(process.cwd(), "apps/admin/.next/prerender-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  routes?: Record<string, { compute?: string; routeType?: string }>;
};

const missing = locales.flatMap((locale) => publicRoutes
  .map((route) => `/${locale}/${route}`)
  .filter((route) => manifest.routes?.[route]?.compute !== "static"));

if (missing.length > 0) {
  throw new Error(`Admin public routes must be prerendered:\n${missing.map((route) => `- ${route}`).join("\n")}`);
}

// The other direction (AUDIT-008). A page built ahead of time has no request in
// which Next could put a script nonce on it, so under the strict Content
// Security Policy every script on it would be blocked. The proxy therefore
// sends no nonce to a public page under its language, and to nothing else. A
// page prerendered anywhere else would go blank the day a deployment enforces
// the policy, so it fails here instead. Next's own 404 and its last-resort
// error page are the exception, because nothing here can change how they are
// built: they still say what they say, and the error page's Retry button,
// which needs its scripts, gives way to reloading the page.
const builtInFallbacks = new Set(["/_not-found", "/_global-error"]);
const wouldGetANonce = Object.entries(manifest.routes ?? {})
  .filter(([route, entry]) => entry.routeType !== "route" && !builtInFallbacks.has(route) && !isCanonicalPublicPath(route))
  .map(([route]) => route);

if (wouldGetANonce.length > 0) {
  throw new Error([
    "These pages are built ahead of time, but apps/admin/proxy.ts would send them a script nonce once CSP_SCRIPT_NONCE is on:",
    ...wouldGetANonce.map((route) => `- ${route}`),
    "A prerendered page cannot carry a nonce, so its scripts would all be blocked. Render the page for each request, or, if it is",
    "a public page that belongs under a language, give it a section in publicRouteSections (apps/admin/src/lib/locale-path.ts).",
  ].join("\n"));
}

console.log(`[prerender] Verified ${locales.length * publicRoutes.length} localized public routes, and that none of the ${Object.keys(manifest.routes ?? {}).length} prerendered routes would be sent a script nonce.`);
