import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";

import { auditLogs, businesses, businessHours, businessMemberships, businessPublicProfiles, closures, phoneNumbers, receptionistProfiles, services, widgetKeys, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { isReceptionistHandle, normalizeBookingMode, normalizeInterfaceLocale, normalizePageUrl, normalizeTransferMode, publicProfileDescriptionFrom, type BookingMode, type HoursWindow, type InterfaceLocale, type PublicProfileAddress, type PublicProfileSettings, type ServiceNameLocale } from "@lobbystack/shared";

import { requireBusinessAdmin } from "../authz";
import { checkAvailability } from "./booking";
import type { DomainContext } from "./context";
import { candidateStartTimes } from "./receptionistActions";

// A business's public page at /profile/<slug>, and its receptionists' pages
// at /profile/<slug>/<handle>. The pages read everything through
// getPublicProfilePage, which returns only what an owner can see and switch
// off in Settings or on the Receptionists page, plus the business's own name,
// hours, services and number that the receptionist already gives callers.
// Knowledge, rules, the transfer number, staff, contacts, calls and messages
// never leave here.

/** A service as the page lists it. */
export type PublicProfileService = {
  name: string;
  /** The name in English or French, when the business gave one. */
  localizedNames?: Partial<Record<ServiceNameLocale, string>>;
  durationMinutes: number;
  description: string | null;
};

/** The earliest free start, for the business's first service. */
export type PublicProfileOpening = {
  startsAt: string;
  serviceName: string;
  serviceLocalizedNames?: Partial<Record<ServiceNameLocale, string>>;
};

/** When a caller can ask the receptionist for a person: at any time, while the business is open, or never. */
export type PublicProfilePersonRequests = "any_time" | "business_hours" | "never";

/** A receptionist as the public pages name it, with what it helps with. */
export type PublicProfileReceptionist = {
  name: string;
  description: string;
  /** Its page under the business page; null for the default receptionist, whose page is the business page. */
  handle: string | null;
  isDefault: boolean;
};

/** Everything the public page shows. A field an owner switched off is null. */
export type PublicBusinessProfile = {
  slug: string;
  /** False only on a member's preview of a page that isn't public yet. */
  published: boolean;
  name: string;
  category: string | null;
  description: string | null;
  timezone: string;
  /** The page's language nearest the business's default customer language: English unless the page is translated into it. */
  defaultLocale: InterfaceLocale;
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
  /** Who answers the page: the default receptionist on the business page. Null for a business without one yet. */
  receptionist: PublicProfileReceptionist | null;
  /** The receptionists a visitor can choose from: the default first, then the listed, active ones in the Receptionists page's order. */
  receptionists: PublicProfileReceptionist[];
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
  return receptionist && receptionist.summarySource !== "placeholder" ? publicProfileDescriptionFrom(receptionist.summary) : null;
}

function addressOf(row: ProfileRow): PublicProfileAddress {
  return { line1: row.addressLine1, line2: row.addressLine2, city: row.city, region: row.region, postalCode: row.postalCode, countryCode: row.countryCode };
}

function localizedNamesOf(value: Record<string, string> | null): Partial<Record<ServiceNameLocale, string>> | undefined {
  if (!value) return undefined;
  const names = { ...(typeof value.en === "string" && value.en.trim() ? { en: value.en.trim() } : {}), ...(typeof value.fr === "string" && value.fr.trim() ? { fr: value.fr.trim() } : {}) };
  return Object.keys(names).length ? names : undefined;
}

export function personRequestsFor(transferMode: string | null | undefined, transferNumber: string | null | undefined): PublicProfilePersonRequests {
  if (!transferNumber) return "never";
  const mode = normalizeTransferMode(transferMode);
  return mode === "always" || mode === "on_request" ? "any_time" : mode === "during_business_hours" ? "business_hours" : "never";
}

/** A receptionist that isn't archived, as the pages read it. */
export type PublicProfileReceptionistRow = {
  id: string;
  name: string;
  description: string;
  handle: string | null;
  isDefault: boolean;
  status: string;
  listed: boolean;
  bookingMode: string;
  transferMode: string;
  transferNumber: string | null;
};

/** The rows the page is built from, read under the business's own RLS context. */
export type PublicProfileRows = {
  business: { slug: string; name: string; timezone: string; defaultLocale: string; websiteUrl: string | null };
  profile: ProfileRow;
  /** The booking and transfer settings of the receptionist that answers the page. */
  receptionist: { bookingMode: string; transferMode: string; transferNumber: string | null } | null;
  /** The business's receptionists that aren't archived, in list order. */
  receptionists: PublicProfileReceptionistRow[];
  /** The receptionist that answers the page; null for the business page, which the default one answers. */
  pageReceptionistId: string | null;
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
  const named = (row: PublicProfileReceptionistRow): PublicProfileReceptionist => ({ name: row.name, description: row.description, handle: row.isDefault ? null : row.handle, isDefault: row.isDefault });
  const answering = rows.receptionists.find((row) => (rows.pageReceptionistId ? row.id === rows.pageReceptionistId : row.isDefault));
  // The default receptionist is always a choice; others when they are listed, active and have a page.
  const choices = rows.receptionists.filter((row) => row.isDefault || (row.listed && row.status === "active" && row.handle));
  const lookahead = input.now.getTime() + CLOSURE_LOOKAHEAD_DAYS * 86_400_000;
  return {
    slug: rows.business.slug,
    published: profile.published,
    name: rows.business.name,
    category: profile.category,
    description: profile.description,
    timezone: rows.business.timezone,
    defaultLocale: normalizeInterfaceLocale(rows.business.defaultLocale) ?? "en",
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
    receptionist: answering ? named(answering) : null,
    receptionists: [...choices.filter((row) => row.isDefault), ...choices.filter((row) => !row.isDefault)].map(named),
  };
}

/**
 * The number a page shows: the newest of the business's active voice numbers
 * that rings its receptionist, else the newest that rings the default one,
 * the business's main line, else the newest of all, which the business page
 * always showed. A number rings the receptionist it names while that one is
 * active, else the default one (app.effective_receptionist).
 */
export function pageNumber(numbers: Array<{ e164: string; receptionistId: string | null }>, receptionists: Array<Pick<PublicProfileReceptionistRow, "id" | "isDefault" | "status">>, pageReceptionistId: string | null): string | null {
  const fallback = receptionists.find((row) => row.isDefault)?.id ?? null;
  const answering = pageReceptionistId ?? fallback;
  const rings = (number: { receptionistId: string | null }) => (receptionists.some((row) => row.id === number.receptionistId && row.status === "active") ? number.receptionistId : fallback);
  const ringing = (receptionistId: string | null) => (receptionistId === null ? undefined : numbers.find((number) => rings(number) === receptionistId));
  return (ringing(answering) ?? ringing(fallback) ?? numbers[0])?.e164 ?? null;
}

async function loadPublicProfileRows(tx: DatabaseTransaction, businessId: string, pageReceptionistId: string | null = null): Promise<PublicProfileRows | null> {
  const [business] = await tx.select({ slug: businesses.slug, name: businesses.name, timezone: businesses.timezone, defaultLocale: businesses.defaultLocale, websiteUrl: businesses.websiteUrl, summary: businesses.summary, summarySource: businesses.summarySource }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  if (!business) return null;
  const [profile] = await tx.select().from(businessPublicProfiles).where(eq(businessPublicProfiles.businessId, businessId)).limit(1);
  const receptionists = await tx.select({
    id: receptionistProfiles.id,
    name: receptionistProfiles.name,
    description: receptionistProfiles.description,
    handle: receptionistProfiles.handle,
    isDefault: receptionistProfiles.isDefault,
    status: receptionistProfiles.status,
    listed: receptionistProfiles.listed,
    bookingMode: receptionistProfiles.bookingMode,
    transferMode: receptionistProfiles.transferMode,
    transferNumber: receptionistProfiles.transferNumber,
  }).from(receptionistProfiles)
    .where(and(eq(receptionistProfiles.businessId, businessId), isNull(receptionistProfiles.archivedAt)))
    .orderBy(desc(receptionistProfiles.isDefault), asc(receptionistProfiles.sortOrder), sql`lower(${receptionistProfiles.name})`, asc(receptionistProfiles.id));
  // The business page belongs to the default receptionist, a receptionist's page to it; the summary is the business's.
  const answering = receptionists.find((row) => (pageReceptionistId ? row.id === pageReceptionistId : row.isDefault));
  const receptionist = answering ? { bookingMode: answering.bookingMode, transferMode: answering.transferMode, transferNumber: answering.transferNumber } : null;
  const hours = await tx.select({ dayOfWeek: businessHours.dayOfWeek, openMinutes: businessHours.openMinutes, closeMinutes: businessHours.closeMinutes }).from(businessHours).where(eq(businessHours.businessId, businessId)).orderBy(asc(businessHours.dayOfWeek), asc(businessHours.openMinutes));
  const closureRows = await tx.select({ startsAt: closures.startsAt, endsAt: closures.endsAt, reason: closures.reason }).from(closures).where(and(eq(closures.businessId, businessId), gt(closures.endsAt, sql`now()`), lt(closures.startsAt, sql`now() + make_interval(days => ${CLOSURE_LOOKAHEAD_DAYS})`))).orderBy(asc(closures.startsAt)).limit(MAX_CLOSURES);
  const serviceRows = await tx.select({ id: services.id, name: services.name, localizedNames: services.localizedNames, description: services.description, durationMinutes: services.durationMinutes }).from(services).where(and(eq(services.businessId, businessId), eq(services.active, true), isNull(services.deletedAt))).orderBy(asc(services.name), asc(services.id)).limit(MAX_SERVICES);
  // The receptionist's own number, newest first as the business snapshot chooses it.
  const numbers = await tx.select({ e164: phoneNumbers.e164, receptionistId: phoneNumbers.receptionistId }).from(phoneNumbers).where(and(eq(phoneNumbers.businessId, businessId), eq(phoneNumbers.status, "active"), eq(phoneNumbers.voiceEnabled, true))).orderBy(desc(phoneNumbers.createdAt), asc(phoneNumbers.id));
  const phone = pageNumber(numbers, receptionists, pageReceptionistId);
  // A page that was never saved previews with the defaults its settings tab offers.
  const profileRow = profile ?? { ...defaultProfileRow(businessId), description: summaryDescription(business), widgetKeyId: (await profileWidgetKeyOptions(tx, businessId))[0]?.id ?? null };
  const widgetKey = profileRow.widgetKeyId
    ? (await tx.select({ keyValue: widgetKeys.keyValue, status: widgetKeys.status }).from(widgetKeys).where(and(eq(widgetKeys.id, profileRow.widgetKeyId), eq(widgetKeys.businessId, businessId))).limit(1))[0] ?? null
    : null;
  const { summary: _summary, summarySource: _summarySource, ...businessRow } = business;
  return { business: businessRow, profile: profileRow, receptionist, receptionists, pageReceptionistId, hours, closures: closureRows, services: serviceRows, phone, widgetKey };
}

/** The business behind a published page's slug, or null for every other slug. */
export async function resolvePublicProfileBusiness(context: DomainContext, slug: string): Promise<string | null> {
  const result = await context.db.execute<{ business_id: string | null }>(sql`select app.resolve_public_profile(${slug}) as business_id`);
  return result.rows[0]?.business_id ?? null;
}

/** What the page needs to sign its chat's receptionist token: never shown on the page. */
export type PublicProfileAccess = {
  businessId: string;
  /** The page's widget key, when it shows a chat. */
  widgetKeyId: string | null;
  /** The receptionist that answers the page; null for a business without a default receptionist yet. */
  receptionistId: string | null;
  /** Whether visitors can pick it, so search engines may list its page. Always true on the business page. */
  listed: boolean;
};

/**
 * A page lookup's result: the page, or the business page's address when the
 * handle names a receptionist that is paused, archived or the default one,
 * which the business page answers for.
 */
export type PublicProfileLookup =
  | { kind: "page"; profile: PublicBusinessProfile; access: PublicProfileAccess }
  | { kind: "businessPage"; slug: string };

/**
 * Everything /profile/<slug> shows, or with handle /profile/<slug>/<handle>,
 * or null for a page that doesn't exist: an unknown slug or handle, an
 * unpublished page or an inactive business. A receptionist's page uses the
 * business page's published switch and widget. With previewUserId, a member
 * of the business also sees a page that isn't published yet. Runs as the
 * worker; context.db must be the worker database.
 */
export async function getPublicProfilePage(context: DomainContext, input: { slug: string; handle?: string | null; previewUserId?: string | null; now?: Date }): Promise<PublicProfileLookup | null> {
  const now = input.now ?? new Date();
  const handle = input.handle?.trim().toLowerCase() || null;
  if (handle !== null && !isReceptionistHandle(handle)) return null;
  let businessId = await resolvePublicProfileBusiness(context, input.slug);
  let preview = false;
  if (!businessId && input.previewUserId) {
    const result = await context.db.execute<{ business_id: string | null }>(sql`select app.resolve_business_by_slug(${input.slug}) as business_id`);
    businessId = result.rows[0]?.business_id ?? null;
    preview = true;
  }
  if (!businessId) return null;
  const id = businessId;
  const found = await withBusinessTransaction(context.db, { businessId: id, actorType: "worker" }, async (tx) => {
    if (preview) {
      const member = (await tx.select({ id: businessMemberships.id }).from(businessMemberships).where(and(eq(businessMemberships.businessId, id), eq(businessMemberships.userId, input.previewUserId!), eq(businessMemberships.status, "active"))).limit(1))[0];
      if (!member) return null;
    }
    let pageReceptionistId: string | null = null;
    if (handle) {
      // A live receptionist keeps its handle to itself; archived ones may share an old one, and still send visitors to the business page.
      const [owner] = await tx.select({ id: receptionistProfiles.id, isDefault: receptionistProfiles.isDefault, status: receptionistProfiles.status, archivedAt: receptionistProfiles.archivedAt })
        .from(receptionistProfiles)
        .where(and(eq(receptionistProfiles.businessId, id), eq(receptionistProfiles.handle, handle)))
        .orderBy(sql`${receptionistProfiles.archivedAt} desc nulls first`)
        .limit(1);
      if (!owner) return null;
      if (owner.isDefault || owner.archivedAt || owner.status !== "active") return { kind: "businessPage" as const };
      pageReceptionistId = owner.id;
    }
    const rows = await loadPublicProfileRows(tx, id, pageReceptionistId);
    return rows ? { kind: "rows" as const, rows } : null;
  });
  if (!found) return null;
  if (found.kind === "businessPage") return { kind: "businessPage", slug: input.slug };
  const { rows } = found;
  // The page may have been unpublished between the lookup and the read.
  if (!preview && !rows.profile.published) return null;
  const firstService = rows.services[0];
  const nextOpening = normalizeBookingMode(rows.receptionist?.bookingMode) === "instant" && firstService && rows.hours.length
    ? await cachedNextOpening(context, { businessId: id, serviceId: firstService.id, durationMinutes: firstService.durationMinutes, timezone: rows.business.timezone, hours: rows.hours, now })
      .then((startsAt) => {
        if (!startsAt) return null;
        const serviceLocalizedNames = localizedNamesOf(firstService.localizedNames);
        return { startsAt, serviceName: firstService.name, ...(serviceLocalizedNames ? { serviceLocalizedNames } : {}) };
      })
    : null;
  const profile = toPublicBusinessProfile(rows, { now, nextOpening });
  const answering = rows.receptionists.find((row) => (rows.pageReceptionistId ? row.id === rows.pageReceptionistId : row.isDefault));
  return {
    kind: "page",
    profile,
    access: {
      businessId: id,
      widgetKeyId: profile.widgetKey ? rows.profile.widgetKeyId : null,
      receptionistId: answering?.id ?? null,
      listed: !rows.pageReceptionistId || Boolean(answering?.listed),
    },
  };
}

/** Everything /profile/<slug> shows, or null for a page that doesn't exist (getPublicProfilePage). */
export async function getPublicBusinessProfile(context: DomainContext, input: { slug: string; previewUserId?: string | null; now?: Date }): Promise<PublicBusinessProfile | null> {
  const found = await getPublicProfilePage(context, input);
  return found?.kind === "page" ? found.profile : null;
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
  /** When the settings were last saved, or null when they never were. */
  updatedAt: string | null;
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
 * The page settings for the dashboard and the API. A business that never
 * saved them gets the defaults: unpublished, every section shown, the
 * receptionist's summary as the description when AI or a person wrote one,
 * and the most recently used widget. lock holds the business's page saves
 * and its saved row until the transaction ends, for a change made from these
 * settings.
 */
export async function getBusinessPublicProfileSettings(tx: DatabaseTransaction, input: { businessId: string; lock?: boolean }): Promise<PublicProfileSettingsView> {
  // The save lock comes before the row's, in the order a save takes them.
  if (input.lock) await lockPublicProfileSaves(tx, input.businessId);
  const profileQuery = tx.select().from(businessPublicProfiles).where(eq(businessPublicProfiles.businessId, input.businessId)).limit(1);
  const [business] = await tx.select({ slug: businesses.slug, name: businesses.name, summary: businesses.summary, summarySource: businesses.summarySource }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1);
  if (!business) throw Object.assign(new Error("Business not found."), { status: 404 });
  const [profile] = await (input.lock ? profileQuery.for("update") : profileQuery);
  const receptionist = { summary: business.summary, summarySource: business.summarySource };
  const keys = await profileWidgetKeyOptions(tx, input.businessId);
  const row = profile ?? defaultProfileRow(input.businessId);
  return {
    saved: Boolean(profile),
    slug: business.slug,
    businessName: business.name,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    updatedAt: profile ? row.updatedAt.toISOString() : null,
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

// One save at a time per business, so two saves can't both record the same
// publish, even the first two, before there's a row to lock.
async function lockPublicProfileSaves(tx: DatabaseTransaction, businessId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('public-profile:' || ${businessId}::uuid::text, 0))`);
}

export const PUBLIC_PROFILE_WIDGET_UNAVAILABLE = "Choose one of this business's active website widgets.";

/** Who changed the page, for the audit log: the account, and the API key or grant that acted for it. */
export type PublicProfileAudit = { actorUserId: string | null; payload?: Record<string, unknown> };

/**
 * Saves the page settings. A widget other than the saved one must be one of
 * the business's active widgets; the saved one may have been paused since,
 * and keeping it changes nothing. Publishing and unpublishing are recorded in
 * the audit log.
 */
export async function savePublicProfileInTransaction(tx: DatabaseTransaction, input: { businessId: string; settings: PublicProfileSettings; audit: PublicProfileAudit }): Promise<void> {
  const { settings } = input;
  await lockPublicProfileSaves(tx, input.businessId);
  const previous = (await tx.select({ published: businessPublicProfiles.published, widgetKeyId: businessPublicProfiles.widgetKeyId }).from(businessPublicProfiles).where(eq(businessPublicProfiles.businessId, input.businessId)).limit(1))[0];
  if (settings.widgetKeyId && settings.widgetKeyId !== previous?.widgetKeyId) {
    const keys = await profileWidgetKeyOptions(tx, input.businessId);
    if (!keys.some((key) => key.id === settings.widgetKeyId)) throw Object.assign(new Error(PUBLIC_PROFILE_WIDGET_UNAVAILABLE), { status: 400, code: "widget_key_unavailable" });
  }
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
    const { actorUserId, payload } = input.audit;
    await tx.insert(auditLogs).values({ businessId: input.businessId, ...(actorUserId ? { actorUserId } : {}), eventType: settings.published ? "public_profile.published" : "public_profile.unpublished", entityType: "business", entityId: input.businessId, ...(payload ? { payload } : {}) });
  }
}

/** Saves the page settings, for an owner or admin of the business. */
export async function updateBusinessPublicProfile(tx: DatabaseTransaction, input: { businessId: string; userId: string; settings: PublicProfileSettings }): Promise<PublicProfileSettingsView> {
  await requireBusinessAdmin(tx, input);
  await savePublicProfileInTransaction(tx, { businessId: input.businessId, settings: input.settings, audit: { actorUserId: input.userId } });
  return await getBusinessPublicProfileSettings(tx, { businessId: input.businessId });
}
