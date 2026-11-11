import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { normalizeIP } from "@better-auth/core/utils/ip";
import { and, eq, sql } from "drizzle-orm";

import { widgetKeys as widgetKeysTable, withBusinessTransaction } from "@lobbystack/db";
import { hashWidgetKey } from "@lobbystack/domain";
import { defaultWidgetConfig, isUuid, normalizeWidgetOrigin, widgetConfigSchema, type WidgetAppearance, type WidgetConfig, type WidgetKeyConfig } from "@lobbystack/shared";

import { getWorkerDatabase } from "./api-helpers";
import { trustedClientIp } from "./trusted-client-ip";

export { hashWidgetKey };

type ResolvedWidgetKey = {
  businessId: string;
  widgetKeyId: string;
};

export async function resolveWidgetKeyByHash(keyHash: string): Promise<ResolvedWidgetKey | null> {
  const result = await getWorkerDatabase().db.execute<{ business_id: string; widget_key_id: string }>(
    sql`select business_id, widget_key_id from app.resolve_business_by_widget_key(${keyHash})`,
  );
  const row = result.rows[0];
  return row ? { businessId: row.business_id, widgetKeyId: row.widget_key_id } : null;
}

/**
 * The bubble color and position an active key's config sets, for the loader to
 * use over its script tag's attributes, and the language its chat opens in when
 * the key sets one. Fields the config leaves out stay out, so the tag's own
 * attributes still apply to them. Null for an unknown or inactive key.
 */
export async function loadWidgetAppearance(key: string): Promise<WidgetAppearance | null> {
  const resolved = await resolveWidgetKeyByHash(hashWidgetKey(key));
  if (!resolved) return null;
  const row = await withBusinessTransaction(getWorkerDatabase().db, { businessId: resolved.businessId, actorType: "worker" }, async (tx) => (
    await tx.select({ config: widgetKeysTable.config }).from(widgetKeysTable).where(and(eq(widgetKeysTable.id, resolved.widgetKeyId), eq(widgetKeysTable.businessId, resolved.businessId))).limit(1)
  )[0]);
  const parsed = widgetConfigSchema.safeParse(row?.config ?? {});
  if (!row || !parsed.success) return null;
  // Without a language of its own, the chat follows the visitor's browser,
  // which only the chat can read, so the loader names none.
  return { ...(parsed.data.color ? { color: parsed.data.color } : {}), ...(parsed.data.position ? { position: parsed.data.position } : {}), ...(parsed.data.localeOverride ? { locale: parsed.data.localeOverride } : {}) };
}

export function normalizeOrigin(value: string): string {
  return normalizeWidgetOrigin(value);
}

export function normalizeAllowedOrigins(origins: unknown): Set<string> {
  if (!Array.isArray(origins)) return new Set();
  const normalized = new Set<string>();
  for (const value of origins) {
    if (typeof value !== "string") continue;
    const origin = normalizeOrigin(value);
    if (origin) normalized.add(origin);
  }
  return normalized;
}

function isLocalhostHttp(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "0.0.0.0" || url.hostname === "::1";
  } catch {
    return false;
  }
}

export function requestWidgetOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (origin) return normalizeOrigin(origin);
  const referer = request.headers.get("referer");
  if (!referer) return null;
  try {
    return normalizeOrigin(new URL(referer).origin);
  } catch {
    return null;
  }
}

/** APP_BASE_URL's origin, where the dashboard and the businesses' profile pages are served. */
function appBaseOrigin(): string {
  try {
    return normalizeOrigin(new URL(process.env.APP_BASE_URL ?? "").origin);
  } catch {
    // Empty when APP_BASE_URL is unset.
    return "";
  }
}

export function isAllowedWidgetOrigin(origin: string, allowedOrigins: unknown, options: { allowAdminOrigin?: boolean; allowLocalhost?: boolean } = {}): boolean {
  const normalized = normalizeOrigin(origin);
  const allowlist = normalizeAllowedOrigins(allowedOrigins);
  if (allowlist.has(normalized)) return true;
  if (options.allowLocalhost !== false && isLocalhostHttp(normalized) && process.env.NODE_ENV !== "production") return true;
  const adminOrigin = appBaseOrigin();
  if (options.allowAdminOrigin !== false && adminOrigin && normalized === adminOrigin) return true;
  return options.allowAdminOrigin !== false && Boolean(adminOrigin) && allowlist.has(adminOrigin);
}

/**
 * Whether the page is the business's own profile page, at /profile/<slug> on
 * the deployment's domain, showing this widget. Widget sessions are otherwise
 * refused on that domain, so only the widget an owner chose for the page runs
 * there, and only while the page is published.
 */
export function isPublicProfileWidgetOrigin(origin: string, profile: { published: boolean | null; widgetKeyId: string | null } | null | undefined, widgetKeyId: string): boolean {
  if (!profile?.published || profile.widgetKeyId !== widgetKeyId) return false;
  const appOrigin = appBaseOrigin();
  // A sandboxed page's origin is the opaque "null", which no deployment has.
  return Boolean(appOrigin) && appOrigin !== "null" && normalizeOrigin(origin) === appOrigin;
}

type WidgetSessionTokenPayload = {
  v: 1;
  widgetKeyId: string;
  businessId: string;
  visitorId: string;
  origin: string;
  exp: number;
  /** The receptionist a business or receptionist page named with its signed token; it answers instead of the key's. */
  receptionistId?: string;
};

function widgetSessionSecret(): string {
  const secret = [process.env.WIDGET_SESSION_SECRET, process.env.BETTER_AUTH_SECRET]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
  if (!secret && process.env.NODE_ENV === "production") throw new Error("WIDGET_SESSION_SECRET or BETTER_AUTH_SECRET is required in production.");
  return secret ?? "development-only-widget-session-secret";
}

function encodeTokenPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// Each kind of token signs with its own key, so one can never pass for the other.
type TokenPurpose = "session" | "receptionist";

function signTokenParts(header: string, payload: string, purpose: TokenPurpose = "session"): string {
  const key = purpose === "session" ? widgetSessionSecret() : createHmac("sha256", widgetSessionSecret()).update("lobbystack:receptionist-page-token").digest();
  return createHmac("sha256", key).update(`${header}.${payload}`).digest("base64url");
}

function signToken(payload: object, purpose: TokenPurpose): string {
  const header = encodeTokenPart({ alg: "HS256", typ: "JWT" });
  const encodedPayload = encodeTokenPart(payload);
  return `${header}.${encodedPayload}.${signTokenParts(header, encodedPayload, purpose)}`;
}

/** The payload of a token signed for the purpose, or null for one that isn't. */
function verifiedPayload(token: string, purpose: TokenPurpose): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) return null;
  const expected = signTokenParts(header, payload, purpose);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length || !timingSafeEqual(expectedBuffer, signatureBuffer)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function createWidgetSessionToken(input: Omit<WidgetSessionTokenPayload, "v" | "exp"> & { ttlSeconds?: number }): { token: string; expiresAt: string } {
  const payload: WidgetSessionTokenPayload = {
    v: 1,
    widgetKeyId: input.widgetKeyId,
    businessId: input.businessId,
    visitorId: input.visitorId,
    origin: normalizeOrigin(input.origin),
    exp: Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? 3600),
    ...(input.receptionistId ? { receptionistId: input.receptionistId } : {}),
  };
  return { token: signToken(payload, "session"), expiresAt: new Date(payload.exp * 1000).toISOString() };
}

export function verifyWidgetSessionToken(token: string): WidgetSessionTokenPayload | null {
  const parsed = verifiedPayload(token, "session");
  if (!parsed) return null;
  if (parsed.v !== 1 || typeof parsed.widgetKeyId !== "string" || typeof parsed.businessId !== "string" || typeof parsed.visitorId !== "string" || typeof parsed.origin !== "string" || typeof parsed.exp !== "number" || parsed.exp <= Math.floor(Date.now() / 1000)) return null;
  if (parsed.receptionistId !== undefined && !isUuid(parsed.receptionistId)) return null;
  return {
    v: 1,
    widgetKeyId: parsed.widgetKeyId,
    businessId: parsed.businessId,
    visitorId: parsed.visitorId,
    origin: normalizeOrigin(parsed.origin),
    exp: parsed.exp,
    ...(typeof parsed.receptionistId === "string" ? { receptionistId: parsed.receptionistId.toLowerCase() } : {}),
  };
}

/**
 * What a business or receptionist page signs when it renders, for its chat:
 * the receptionist that answers it, through the page's widget key. The page
 * hands it to the loader, and the session route checks it, so a visitor can't
 * reach an unlisted receptionist by editing a request. It names no visitor,
 * so any visitor of the page may use it.
 */
export type ReceptionistPageTokenPayload = { v: 1; purpose: "receptionist_page"; businessId: string; widgetKeyId: string; receptionistId: string; exp: number };

// A page left open renews its chat's session every hour with the same token, so it lasts long past any visit.
const RECEPTIONIST_PAGE_TOKEN_TTL_SECONDS = 30 * 86_400;

export function createReceptionistPageToken(input: { businessId: string; widgetKeyId: string; receptionistId: string; ttlSeconds?: number }): string {
  const payload: ReceptionistPageTokenPayload = {
    v: 1,
    purpose: "receptionist_page",
    businessId: input.businessId,
    widgetKeyId: input.widgetKeyId,
    receptionistId: input.receptionistId.toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? RECEPTIONIST_PAGE_TOKEN_TTL_SECONDS),
  };
  return signToken(payload, "receptionist");
}

export function verifyReceptionistPageToken(token: string): ReceptionistPageTokenPayload | null {
  const parsed = verifiedPayload(token, "receptionist");
  if (!parsed) return null;
  if (parsed.v !== 1 || parsed.purpose !== "receptionist_page" || typeof parsed.businessId !== "string" || typeof parsed.widgetKeyId !== "string" || !isUuid(parsed.receptionistId) || typeof parsed.exp !== "number" || parsed.exp <= Math.floor(Date.now() / 1000)) return null;
  return { v: 1, purpose: "receptionist_page", businessId: parsed.businessId, widgetKeyId: parsed.widgetKeyId, receptionistId: parsed.receptionistId.toLowerCase(), exp: parsed.exp };
}

export function serializeWidgetKeyConfig(row: { id: string; status: string | null; label: string | null; allowedOrigins: unknown; config: unknown; lastUsedAt: Date | null; createdAt: Date }): WidgetKeyConfig {
  const parsed = widgetConfigSchema.safeParse(row.config ?? {});
  const config = Object.fromEntries(
    Object.entries({ ...defaultWidgetConfig, ...(parsed.success ? parsed.data : {}) }).filter(([, value]) => value !== undefined),
  ) as unknown as WidgetConfig;
  return {
    id: row.id,
    label: row.label,
    status: (row.status === "active" || row.status === "disabled" || row.status === "revoked" ? row.status : "active"),
    allowedOrigins: Array.isArray(row.allowedOrigins) ? row.allowedOrigins.filter((value): value is string => typeof value === "string").map(normalizeOrigin) : [],
    config,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function touchWidgetKeyLastUsed(input: { businessId: string; widgetKeyId: string }): Promise<void> {
  await withBusinessTransaction(getWorkerDatabase().db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    await tx.update(widgetKeysTable).set({ lastUsedAt: new Date(), updatedAt: new Date() }).where(and(eq(widgetKeysTable.id, input.widgetKeyId), eq(widgetKeysTable.businessId, input.businessId)));
  });
}

export function requestIpHash(request: Request): string | undefined {
  // Shared trusted-IP derivation: opt in only when ingress overwrites the
  // configured single-value header. No trusted header means no IP dimension,
  // and the widget key limits still apply.
  const ip = trustedClientIp(request);
  if (!ip) return undefined;
  // One host usually owns a whole IPv6 /64, so count the subnet as one client.
  return createHash("sha256").update(normalizeIP(ip, { ipv6Subnet: 64 })).digest("hex");
}
