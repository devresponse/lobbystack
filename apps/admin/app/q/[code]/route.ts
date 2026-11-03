import { followEntryLink } from "@lobbystack/domain";

import { loadBranding } from "@/lib/branding";
import { createWorkerDomainContext } from "@/lib/domain-context";
import { reportServerError } from "@/lib/error-reporting";
import { localeTag } from "@/lib/locale";
import { localeFromRequestHeaders } from "@/lib/locale-request";
import { serverTranslator } from "@/lib/server-translation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A QR sign's short link, /q/<code> (followEntryLink): it counts the scan and
// opens the page of the receptionist the link names, or the business page
// when the link or that receptionist is paused or archived. The link can be
// pointed elsewhere at any time, so the redirect is temporary and never
// cached. Nothing about the visitor is kept.

type Params = { params: Promise<{ code: string }> };

const escape = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** What a scan of a code that opens nothing shows, in the visitor's language. */
async function notFound(request: Request): Promise<Response> {
  const { locale } = localeFromRequestHeaders(request.headers);
  const branding = await loadBranding().catch(() => null);
  const t = serverTranslator(locale, "profile", branding?.appName);
  const body = `<!doctype html><html lang="${localeTag(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escape(t("entryLink.notFound.title"))}</title></head>`
    + `<body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#fff;color:#000;color-scheme:light">`
    + `<main style="box-sizing:border-box;max-width:720px;min-height:100svh;margin:0 auto;padding:64px 20px;display:flex;flex-direction:column;justify-content:center;gap:16px">`
    + `<h1 style="margin:0;font-size:40px;line-height:1;font-weight:780;letter-spacing:-0.035em">${escape(t("entryLink.notFound.title"))}</h1>`
    + `<p style="margin:0;font-size:17px;line-height:1.55;color:#3D3D3D">${escape(t("entryLink.notFound.body"))}</p>`
    + `</main></body></html>`;
  return new Response(body, { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
}

async function follow(request: Request, code: string, count: boolean): Promise<Response> {
  let destination;
  try {
    destination = await followEntryLink(createWorkerDomainContext(), { code, count });
  } catch (error) {
    // The sign can't open its page right now; the visitor can scan again.
    void reportServerError(error, { operation: "entry_link.follow", route: "/q/[code]" });
    return new Response("The page couldn't open. Try again in a moment.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store", "retry-after": "5" } });
  }
  if (!destination) return await notFound(request);
  // A relative address keeps the visitor on the domain the sign named. The page's language choice, if any, goes along.
  const language = new URL(request.url).searchParams.get("lng");
  const location = language && /^[a-z]{2}$/.test(language) ? `${destination.path}?lng=${language}` : destination.path;
  return new Response(null, { status: 307, headers: { location, "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
}

export async function GET(request: Request, { params }: Params) {
  return await follow(request, (await params).code, true);
}

// A link preview or a checker only looks: it isn't a scan.
export async function HEAD(request: Request, { params }: Params) {
  return await follow(request, (await params).code, false);
}
