import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { businesses, businessPublicProfiles, widgetKeys, withBusinessTransaction } from "@lobbystack/db";
import { bearerToken } from "@lobbystack/domain";
import type { WidgetConfig, WidgetKeyConfig } from "@lobbystack/shared";

import { getWorkerDatabase, jsonError } from "./api-helpers";
import { hashWidgetKey, isAllowedWidgetOrigin, isPublicProfileWidgetOrigin, normalizeOrigin, requestWidgetOrigin, resolveWidgetKeyByHash, serializeWidgetKeyConfig, verifyWidgetSessionToken } from "./widget-keys";

export type WidgetSession = {
  businessId: string;
  widgetKeyId: string;
  keyHash: string;
  origin: string | null;
  key: WidgetKeyConfig;
  businessName: string;
  businessSlug: string;
  defaultLocale: "en" | "fr";
  config: WidgetConfig;
  visitorId?: string;
};

export type WidgetAccessSuccess = { ok: true; session: WidgetSession };
export type WidgetAccessFailure = { ok: false; response: NextResponse };
export type WidgetAccessResult = WidgetAccessSuccess | WidgetAccessFailure;

async function loadWidgetSession(businessId: string, widgetKeyId: string) {
  return await withBusinessTransaction(getWorkerDatabase().db, { businessId, actorType: "worker" }, async (tx) => {
    const [keyRow, business] = await Promise.all([
      // The business's profile page comes with the key, in the same query.
      tx.select({ key: widgetKeys, profilePublished: businessPublicProfiles.published, profileWidgetKeyId: businessPublicProfiles.widgetKeyId })
        .from(widgetKeys)
        .leftJoin(businessPublicProfiles, eq(businessPublicProfiles.businessId, widgetKeys.businessId))
        .where(and(eq(widgetKeys.id, widgetKeyId), eq(widgetKeys.businessId, businessId))).limit(1).then((rows) => rows[0]),
      tx.select({ name: businesses.name, slug: businesses.slug, defaultLocale: businesses.defaultLocale }).from(businesses).where(eq(businesses.id, businessId)).limit(1).then((rows) => rows[0]),
    ]);
    if (!keyRow) return null;
    const key = serializeWidgetKeyConfig(keyRow.key as unknown as Parameters<typeof serializeWidgetKeyConfig>[0]);
    return {
      session: {
        businessId,
        widgetKeyId,
        key,
        config: key.config as WidgetConfig,
        businessName: business?.name ?? "",
        businessSlug: business?.slug ?? "",
        defaultLocale: (business?.defaultLocale === "fr" ? "fr" : "en") as "en" | "fr",
      },
      profile: { published: keyRow.profilePublished, widgetKeyId: keyRow.profileWidgetKeyId },
    };
  });
}

type LoadedWidget = NonNullable<Awaited<ReturnType<typeof loadWidgetSession>>>;

/** Whether the page may run the widget: one of the key's websites, or its business's published profile page. */
function isAllowedOrigin(origin: string, loaded: LoadedWidget, options: { strictOrigin?: boolean } = {}): boolean {
  return isAllowedWidgetOrigin(origin, loaded.session.key.allowedOrigins, options.strictOrigin ? { allowAdminOrigin: false, allowLocalhost: false } : {})
    || isPublicProfileWidgetOrigin(origin, loaded.profile, loaded.session.widgetKeyId);
}

export async function resolveWidgetAccess(request: Request, key: string | null | undefined, options: { requireOrigin?: boolean; strictOrigin?: boolean } = {}): Promise<WidgetAccessResult> {
  if (!key) return { ok: false, response: jsonError("A widget key is required.", 401, "widget_key_required") };
  const keyHash = hashWidgetKey(key);
  const resolved = await resolveWidgetKeyByHash(keyHash);
  if (!resolved) return { ok: false, response: jsonError("The widget key is invalid or inactive.", 404, "widget_key_invalid") };
  const origin = requestWidgetOrigin(request);
  const loaded = await loadWidgetSession(resolved.businessId, resolved.widgetKeyId);
  if (!loaded) return { ok: false, response: jsonError("The widget key is invalid or inactive.", 404, "widget_key_invalid") };
  const session = { ...loaded.session, keyHash, origin };
  if (session.key.status !== "active") return { ok: false, response: jsonError("The widget is disabled.", 403, "widget_disabled") };
  if (options.requireOrigin && origin === null) {
    return { ok: false, response: jsonError("A browser origin is required to load this widget.", 403, "widget_origin_required") };
  }
  if (origin !== null && !isAllowedOrigin(origin, loaded, options)) {
    return { ok: false, response: jsonError("This website is not authorized to load this widget.", 403, "widget_origin_denied") };
  }
  return { ok: true, session };
}

export async function resolveWidgetSessionAccess(request: Request): Promise<WidgetAccessResult> {
  const payload = verifyWidgetSessionToken(bearerToken(request.headers.get("authorization")) ?? "");
  if (!payload) return { ok: false, response: jsonError("The widget session is invalid or expired.", 401, "widget_session_invalid") };
  const parentOrigin = request.headers.get("x-widget-parent-origin");
  if (!parentOrigin || normalizeOrigin(parentOrigin) !== payload.origin) {
    return { ok: false, response: jsonError("The widget session origin is invalid.", 403, "widget_origin_denied") };
  }
  const loaded = await loadWidgetSession(payload.businessId, payload.widgetKeyId);
  if (!loaded) return { ok: false, response: jsonError("The widget session is invalid.", 401, "widget_session_invalid") };
  const session = { ...loaded.session, keyHash: "", origin: payload.origin, visitorId: payload.visitorId };
  if (session.key.status !== "active") return { ok: false, response: jsonError("The widget is disabled.", 403, "widget_disabled") };
  if (!isAllowedOrigin(payload.origin, loaded, { strictOrigin: true })) {
    return { ok: false, response: jsonError("This website is not authorized to load this widget.", 403, "widget_origin_denied") };
  }
  return { ok: true, session };
}
