import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";

import { auditLogs, businesses, businessHours, businessMemberships, businessPublicProfiles, closures, phoneNumbers, receptionistProfiles, services, widgetKeys, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { normalizeBookingMode, normalizePageUrl, normalizeTransferMode, PUBLIC_PROFILE_LIMITS, type BookingMode, type HoursWindow, type PublicProfileAddress, type PublicProfileSettings, type RuntimeLocale } from "@lobbystack/shared";

import { requireBusinessAdmin } from "../authz";
import { checkAvailability } from "./booking";
import type { DomainContext } from "./context";
import { candidateStartTimes } from "./receptionistActions";

// A business's public page at /profile/<slug>. The page reads everything
// through getPublicBusinessProfile, which returns only what an owner can see
// and switch off in Settings, plus the business's own name, hours, services
// and number that the receptionist already gives callers. Knowledge, rules,
// the transfer number, staff, contacts, calls and messages never leave here.

/** A service as the page lists it. */
export type PublicProfileService = {
  name: string;
  /** The name in English or French, when the business gave one. */
  localizedNames?: Partial<Record<RuntimeLocale, string>>;
  durationMinutes: number;
  description: string | null;
};

/** The earliest free start, for the business's first service. */
export type PublicProfileOpening = {
  startsAt: string;
  serviceName: string;
  serviceLocalizedNames?: Partial<Record<RuntimeLocale, string>>;
};

/** When a caller can ask the receptionist for a person: at any time, while the business is open, or never. */
export type PublicProfilePersonRequests = "any_time" | "business_hours" | "never";

/** Everything the public page shows. A field an owner switched off is null. */
export type PublicBusinessProfile = {
  slug: string;
  /** False only on a member's preview of a page that isn't public yet. */
  published: boolean;
  name: string;
  category: string | null;
  description: string | null;
  timezone: string;
  defaultLocale: RuntimeLocale;
  /** Null when no part of the address is set. */
  address: PublicProfileAddress | null;
  /** Whether the owner shows a map of the address. */
  showMap: boolean;
  /** The number callers reach the receptionist on, in E.164. */
  phone: string | null;
  email: string | null;
  websiteUrl: string | null;
  /** The weekly hours, empty when none are set. */
  hours: HoursWindow[] | null;
  /** Closures that haven't ended and start within 30 days. */
  closures: Array<{ startsAt: string; endsAt: string; reason: string }> | null;
  services: PublicProfileService[] | null;
  bookingMode: BookingMode;
  personRequests: PublicProfilePersonRequests;
  /** The public key of the website widget the page shows. */
  widgetKey: string | null;
  nextOpening: PublicProfileOpening | null;
};

const CLOSURE_LOOKAHEAD_DAYS = 30;
const MAX_CLOSURES = 5;
const MAX_SERVICES = 40;

type ProfileRow = typeof businessPublicProfiles.$inferSelect;

/** What a business that never saved its page settings gets: nothing public, every section shown. */
function defaultProfileRow(businessId: string): ProfileRow {
  const now = new Date(0);
  return {
    businessId, published: false, publishedAt: null, category: null, description: null,
    addressLine1: null, addressLine2: null, city: null, region: null, postalCode: null, countryCode: null,
    publicEmail: null, showPhone: true, showHours: true, showServices: true, showMap: true, widgetKeyId: null,
    createdAt: now, updatedAt: now,
  };
}

/** The receptionist's summary, which describes a business that never saved its page, when AI or a person wrote it. */
function summaryDescription(receptionist: { summary: string; summarySource: string } | null | undefined): string | null {
  return receptionist && receptionist.summarySource !== "placeholder" ? receptionist.summary.trim().slice(0, PUBLIC_PROFILE_LIMITS.description) || null : null;
}

function addressOf(row: ProfileRow): PublicProfileAddress {
  return { line1: row.addressLine1, line2: row.addressLine2, city: row.city, region: row.region, postalCode: row.postalCode, countryCode: row.countryCode };
}

function localizedNamesOf(value: Record<string, string> | null): Partial<Record<RuntimeLocale, string>> | undefined {
  if (!value) return undefined;
  const names = { ...(typeof value.en === "string" && value.en.trim() ? { en: value.en.trim() } : {}), ...(typeof value.fr === "string" && value.fr.trim() ? { fr: value.fr.trim() } : {}) };
  return Object.keys(names).length ? names : undefined;
}

export function personRequestsFor(transferMode: string | null | undefined, transferNumber: string | null | undefined): PublicProfilePersonRequests {
  if (!transferNumber) return "never";
  const mode = normalizeTransferMode(transferMode);
  return mode === "always" || mode === "on_request" ? "any_time" : mode === "during_business_hours" ? "business_hours" : "never";
}

/** The rows the page is built from, read under the business's own RLS context. */
export type PublicProfileRows = {
  business: { slug: string; name: string; timezone: string; defaultLocale: string; websiteUrl: string | null };
  profile: ProfileRow;
  receptionist: { bookingMode: string; transferMode: string; transferNumber: string | null } | null;
  hours: HoursWindow[];
  closures: Array<{ startsAt: Date; endsAt: Date; reason: string }>;
  services: Array<{ id: string; name: string; localizedNames: Record<string, string> | null; description: string | null; durationMinutes: number }>;
  phone: string | null;
  widgetKey: { keyValue: string | null; status: string } | null;
};

/**
 * The page's public shape from its rows. Sections the owner switched off come
 * back null, and only an active widget key with a stored key is shown.
 */
export function toPublicBusinessProfile(rows: PublicProfileRows, input: { now: Date; nextOpening?: PublicProfileOpening | null }): PublicBusinessProfile {
  const { profile } = rows;
  const address = addressOf(profile);
  const lookahead = input.now.getTime() + CLOSURE_LOOKAHEAD_DAYS * 86_400_000;
  return {
    slug: rows.business.slug,
    published: profile.published,
    name: rows.business.name,
    category: profile.category,
    description: profile.description,
    timezone: rows.business.timezone,
    defaultLocale: rows.business.defaultLocale === "fr" ? "fr" : "en",
    address: Object.values(address).some(Boolean) ? address : null,
    showMap: profile.showMap,
    phone: profile.showPhone ? rows.phone : null,
    email: profile.publicEmail,
    websiteUrl: normalizePageUrl(rows.business.websiteUrl),
    hours: profile.showHours ? rows.hours : null,
    closures: profile.showHours
      ? rows.closures
        .filter((closure) => closure.endsAt.getTime() > input.now.getTime() && closure.startsAt.getTime() < lookahead)
        .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime())
        .slice(0, MAX_CLOSURES)
        .map((closure) => ({ startsAt: closure.startsAt.toISOString(), endsAt: closure.endsAt.toISOString(), reason: closure.reason }))
      : null,
    services: profile.showServices
      ? rows.services.slice(0, MAX_SERVICES).map((service) => {
        const localizedNames = localizedNamesOf(service.localizedNames);
        return { name: service.name, ...(localizedNames ? { localizedNames } : {}), durationMinutes: service.durationMinutes, description: service.description?.trim() || null };
      })
      : null,
    bookingMode: normalizeBookingMode(rows.receptionist?.bookingMode),
    personRequests: personRequestsFor(rows.receptionist?.transferMode, rows.receptionist?.transferNumber),
    widgetKey: rows.widgetKey?.status === "active" && rows.widgetKey.keyValue ? rows.widgetKey.keyValue : null,
    nextOpening: input.nextOpening ?? null,
  };
}

async function loadPublicProfileRows(tx: DatabaseTransaction, businessId: string): Promise<PublicProfileRows | null> {
  const [business, profile, receptionist, hours, closureRows, serviceRows, phone] = await Promise.all([
    tx.select({ slug: businesses.slug, name: businesses.name, timezone: businesses.timezone, defaultLocale: businesses.defaultLocale, websiteUrl: businesses.websiteUrl }).from(businesses).where(eq(businesses.id, businessId)).limit(1).then((rows) => rows[0]),
    tx.select().from(businessPublicProfiles).where(eq(businessPublicProfiles.businessId, businessId)).limit(1).then((rows) => rows[0]),
    tx.select({ bookingMode: receptionistProfiles.bookingMode, transferMode: receptionistProfiles.transferMode, transferNumber: receptionistProfiles.transferNumber, summary: receptionistProfiles.summary, summarySource: receptionistProfiles.summarySource }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, businessId)).limit(1).then((rows) => rows[0] ?? null),
    tx.select({ dayOfWeek: businessHours.dayOfWeek, openMinutes: businessHours.openMinutes, closeMinutes: businessHours.closeMinutes }).from(businessHours).where(eq(businessHours.businessId, businessId)).orderBy(asc(businessHours.dayOfWeek), asc(businessHours.openMinutes)),
    tx.select({ startsAt: closures.startsAt, endsAt: closures.endsAt, reason: closures.reason }).from(closures).where(and(eq(closures.businessId, businessId), gt(closures.endsAt, sql`now()`), lt(closures.startsAt, sql`now() + make_interval(days => ${CLOSURE_LOOKAHEAD_DAYS})`))).orderBy(asc(closures.startsAt)).limit(MAX_CLOSURES),
    tx.select({ id: services.id, name: services.name, localizedNames: services.localizedNames, description: services.description, durationMinutes: services.durationMinutes }).from(services).where(and(eq(services.businessId, businessId), eq(services.active, true), isNull(services.deletedAt))).orderBy(asc(services.name), asc(services.id)).limit(MAX_SERVICES),
    // The receptionist's own number, chosen as the business snapshot chooses it.
    tx.select({ e164: phoneNumbers.e164 }).from(phoneNumbers).where(and(eq(phoneNumbers.businessId, businessId), eq(phoneNumbers.status, "active"), eq(phoneNumbers.voiceEnabled, true))).orderBy(desc(phoneNumbers.createdAt), asc(phoneNumbers.id)).limit(1).then((rows) => rows[0]?.e164 ?? null),
  ]);
  if (!business) return null;
  // A page that was never saved previews with the defaults its settings tab offers.
  const profileRow = profile ?? { ...defaultProfileRow(businessId), description: summaryDescription(receptionist), widgetKeyId: (await profileWidgetKeyOptions(tx, businessId))[0]?.id ?? null };
  const widgetKey = profileRow.widgetKeyId
    ? (await tx.select({ keyValue: widgetKeys.keyValue, status: widgetKeys.status }).from(widgetKeys).where(and(eq(widgetKeys.id, profileRow.widgetKeyId), eq(widgetKeys.businessId, businessId))).limit(1))[0] ?? null
    : null;
  return { business, profile: profileRow, receptionist, hours, closures: closureRows, services: serviceRows, phone, widgetKey };
}

/** The business behind a published page's slug, or null for every other slug. */
export async function resolvePublicProfileBusiness(context: DomainContext, slug: string): Promise<string | null> {
  const result = await context.db.execute<{ business_id: string | null }>(sql`select app.resolve_public_profile(${slug}) as business_id`);
  return result.rows[0]?.business_id ?? null;
}

/**
 * Everything /profile/<slug> shows, or null for a page that doesn't exist:
 * an unknown slug, an unpublished page or an inactive business. With
 * previewUserId, a member of the business also sees a page that isn't
 * published yet. Runs as the worker; context.db must be the worker database.
 */
export async function getPublicBusinessProfile(context: DomainContext, input: { slug: string; previewUserId?: string | null; now?: Date }): Promise<PublicBusinessProfile | null> {
  const now = input.now ?? new Date();
  let businessId = await resolvePublicProfileBusiness(context, input.slug);
  let preview = false;
  if (!businessId && input.previewUserId) {
    const result = await context.db.execute<{ business_id: string | null }>(sql`select app.resolve_business_by_slug(${input.slug}) as business_id`);
    businessId = result.rows[0]?.business_id ?? null;
    preview = true;
  }
  if (!businessId) return null;
  const id = businessId;
  const rows = await withBusinessTransaction(context.db, { businessId: id, actorType: "worker" }, async (tx) => {
    if (preview) {
      const member = (await tx.select({ id: businessMemberships.id }).from(businessMemberships).where(and(eq(businessMemberships.businessId, id), eq(businessMemberships.userId, input.previewUserId!), eq(businessMemberships.status, "active"))).limit(1))[0];
      if (!member) return null;
    }
    return await loadPublicProfileRows(tx, id);
  });
  // The page may have been unpublished between the lookup and the read.
  if (!rows || (!preview && !rows.profile.published)) return null;
  const firstService = rows.services[0];
  const nextOpening = normalizeBookingMode(rows.receptionist?.bookingMode) === "instant" && firstService && rows.hours.length
    ? await cachedNextOpening(context, { businessId: id, serviceId: firstService.id, durationMinutes: firstService.durationMinutes, timezone: rows.business.timezone, hours: rows.hours, now })
      .then((startsAt) => {
        if (!startsAt) return null;
        const serviceLocalizedNames = localizedNamesOf(firstService.localizedNames);
        return { startsAt, serviceName: firstService.name, ...(serviceLocalizedNames ? { serviceLocalizedNames } : {}) };
      })
    : null;
  return toPublicBusinessProfile(rows, { now, nextOpening });
}

const NEXT_OPENING_DAYS = 14;
const NEXT_OPENING_BATCH = 6;
const NEXT_OPENING_TTL_MS = 5 * 60_000;
const NEXT_OPENING_CACHE_LIMIT = 2_000;

/**
 * The earliest start in the next 14 days that the receptionist could book for
 * the service, checked start by start from now as the availability API does.
 * Null when nothing is free, or when nobody can take the service at all.
 */
export async function findNextOpening(context: DomainContext, input: { businessId: string; serviceId: string; durationMinutes: number; timezone: string; hours: HoursWindow[]; now?: Date }): Promise<string | null> {
  const now = input.now ?? new Date();
  const today = DateTime.fromJSDate(now, { zone: input.timezone });
  if (!today.isValid) return null;
  for (let day = 0; day < NEXT_OPENING_DAYS; day += 1) {
    const date = today.plus({ days: day }).toISODate()!;
    const candidates = candidateStartTimes({ date, timezone: input.timezone, hours: input.hours, durationMinutes: input.durationMinutes, now });
    for (let index = 0; index < candidates.length; index += NEXT_OPENING_BATCH) {
      const batch = candidates.slice(index, index + NEXT_OPENING_BATCH);
      const checks = await Promise.all(batch.map(async (startsAt) => await checkAvailability(context, { businessId: input.businessId, serviceId: input.serviceId, startsAt, timezone: input.timezone })));
      const open = checks.findIndex((check) => check.slots.length > 0);
      if (open >= 0) return new Date(batch[open]!).toISOString();
      // No staff member can take the service, or the calendar isn't synced:
      // later starts won't be any different.
      if (checks.some((check) => check.reason === "no_staff" || check.reason === "calendar_not_synced")) return null;
    }
  }
  return null;
}

const nextOpenings = new Map<string, { expiresAt: number; startsAt: Promise<string | null> }>();

/** findNextOpening, kept for five minutes per business and service, since it can take dozens of checks. */
export async function cachedNextOpening(context: DomainContext, input: Parameters<typeof findNextOpening>[1]): Promise<string | null> {
  const key = `${input.businessId}:${input.serviceId}:${input.durationMinutes}`;
  const nowMs = Date.now();
  const cached = nextOpenings.get(key);
  if (cached && cached.expiresAt > nowMs) {
    const startsAt = await cached.startsAt;
    // A cached start that has since passed means looking again.
    if (!startsAt || Date.parse(startsAt) > nowMs) return startsAt;
  }
  if (nextOpenings.size >= NEXT_OPENING_CACHE_LIMIT) {
    for (const [entryKey, entry] of nextOpenings) if (entry.expiresAt <= nowMs) nextOpenings.delete(entryKey);
    if (nextOpenings.size >= NEXT_OPENING_CACHE_LIMIT) nextOpenings.delete(nextOpenings.keys().next().value!);
  }
  // A failed search shows no next opening and is retried on the next view.
  const startsAt = findNextOpening(context, input).catch(() => {
    nextOpenings.delete(key);
    return null;
  });
  nextOpenings.set(key, { expiresAt: nowMs + NEXT_OPENING_TTL_MS, startsAt });
  return await startsAt;
}

/** Forgets cached next openings. For tests. */
export function clearNextOpeningCache(): void {
  nextOpenings.clear();
}

/** A widget key the page can show: active, and kept so its snippet can be built. */
export type PublicProfileWidgetKeyOption = { id: string; label: string | null; lastUsedAt: string | null; createdAt: string };

export type PublicProfileSettingsView = {
  /** Whether the business ever saved its page settings. */
  saved: boolean;
  slug: string;
  businessName: string;
  publishedAt: string | null;
  settings: PublicProfileSettings;
  widgetKeys: PublicProfileWidgetKeyOption[];
};

async function profileWidgetKeyOptions(tx: DatabaseTransaction, businessId: string): Promise<PublicProfileWidgetKeyOption[]> {
  const rows = await tx.select({ id: widgetKeys.id, label: widgetKeys.label, lastUsedAt: widgetKeys.lastUsedAt, createdAt: widgetKeys.createdAt, keyValue: widgetKeys.keyValue })
    .from(widgetKeys)
    .where(and(eq(widgetKeys.businessId, businessId), eq(widgetKeys.status, "active")))
    .orderBy(sql`${widgetKeys.lastUsedAt} desc nulls last`, desc(widgetKeys.createdAt));
  return rows.filter((row) => row.keyValue).map((row) => ({ id: row.id, label: row.label, lastUsedAt: row.lastUsedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() }));
}

/**
 * The page settings for the dashboard. A business that never saved them gets
 * the defaults: unpublished, every section shown, the receptionist's summary
 * as the description when AI or a person wrote one, and the most recently
 * used widget.
 */
export async function getBusinessPublicProfileSettings(tx: DatabaseTransaction, input: { businessId: string }): Promise<PublicProfileSettingsView> {
  const [business, profile, receptionist, keys] = await Promise.all([
    tx.select({ slug: businesses.slug, name: businesses.name }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1).then((rows) => rows[0]),
    tx.select().from(businessPublicProfiles).where(eq(businessPublicProfiles.businessId, input.businessId)).limit(1).then((rows) => rows[0]),
    tx.select({ summary: receptionistProfiles.summary, summarySource: receptionistProfiles.summarySource }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, input.businessId)).limit(1).then((rows) => rows[0]),
    profileWidgetKeyOptions(tx, input.businessId),
  ]);
  if (!business) throw Object.assign(new Error("Business not found."), { status: 404 });
  const row = profile ?? defaultProfileRow(input.businessId);
  return {
    saved: Boolean(profile),
    slug: business.slug,
    businessName: business.name,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    settings: {
      published: row.published,
      category: row.category,
      description: profile ? row.description : summaryDescription(receptionist),
      address: addressOf(row),
      publicEmail: row.publicEmail,
      showPhone: row.showPhone,
      showHours: row.showHours,
      showServices: row.showServices,
      showMap: row.showMap,
      widgetKeyId: profile ? row.widgetKeyId : keys[0]?.id ?? null,
    },
    widgetKeys: keys,
  };
}

/**
 * Saves the page settings, for an owner or admin of the business. The widget
 * must be one of the business's active widgets. Publishing and unpublishing
 * are recorded in the audit log.
 */
export async function updateBusinessPublicProfile(tx: DatabaseTransaction, input: { businessId: string; userId: string; settings: PublicProfileSettings }): Promise<PublicProfileSettingsView> {
  await requireBusinessAdmin(tx, input);
  const { settings } = input;
  if (settings.widgetKeyId) {
    const keys = await profileWidgetKeyOptions(tx, input.businessId);
    if (!keys.some((key) => key.id === settings.widgetKeyId)) throw Object.assign(new Error("Choose one of this business's active website widgets."), { status: 400, code: "widget_key_unavailable" });
  }
  // Locks the row, so two saves can't both record the same publish.
  const previous = (await tx.select({ published: businessPublicProfiles.published }).from(businessPublicProfiles).where(eq(businessPublicProfiles.businessId, input.businessId)).limit(1).for("update"))[0];
  const wasPublished = previous?.published ?? false;
  const now = new Date();
  const values = {
    published: settings.published,
    category: settings.category,
    description: settings.description,
    addressLine1: settings.address.line1,
    addressLine2: settings.address.line2,
    city: settings.address.city,
    region: settings.address.region,
    postalCode: settings.address.postalCode,
    countryCode: settings.address.countryCode,
    publicEmail: settings.publicEmail,
    showPhone: settings.showPhone,
    showHours: settings.showHours,
    showServices: settings.showServices,
    showMap: settings.showMap,
    widgetKeyId: settings.widgetKeyId,
    updatedAt: now,
    ...(settings.published && !wasPublished ? { publishedAt: now } : {}),
  };
  await tx.insert(businessPublicProfiles).values({ businessId: input.businessId, ...values }).onConflictDoUpdate({ target: businessPublicProfiles.businessId, set: values });
  if (settings.published !== wasPublished) {
    await tx.insert(auditLogs).values({ businessId: input.businessId, actorUserId: input.userId, eventType: settings.published ? "public_profile.published" : "public_profile.unpublished", entityType: "business", entityId: input.businessId });
  }
  return await getBusinessPublicProfileSettings(tx, { businessId: input.businessId });
}
