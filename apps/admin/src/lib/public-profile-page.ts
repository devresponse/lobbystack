import { getCountryCallingCode, isSupportedCountry, parsePhoneNumberFromString } from "libphonenumber-js/min";
import { DateTime } from "luxon";

import type { PublicBusinessProfile, PublicProfileService } from "@lobbystack/domain";
import { formatPublicProfileAddress, intlLocale, openStatus, publicProfilePath, type HoursWindow, type PublicProfileAddress } from "@lobbystack/shared";

import { SUPPORTED_LOCALES, type SupportedLocale } from "./locale";
import type { Translate } from "./server-translation";

// What a business's profile page at /profile/<slug> shows, worked out from its
// public profile: the open-now line, the week's hours, closures, the next
// opening, the phone number, map links and the search engines' summary. Times
// are the business's own, in its time zone.

type Clock = { locale: SupportedLocale; timezone: string; now: Date; t: Translate };

/** The page's address on this deployment. */
export function publicProfileUrl(slug: string, environment: Readonly<Record<string, string | undefined>> = process.env): string {
  return new URL(publicProfilePath(slug), environment.APP_BASE_URL || "http://localhost:3000").toString();
}

/**
 * The page's address in each language, for search engines: each language's
 * own address, and the plain one, which opens in the visitor's language, as
 * the default.
 */
export function profileAlternates(pageUrl: string, locale: SupportedLocale): { canonical: string; languages: Record<string, string> } {
  const inLanguage = (language: SupportedLocale) => `${pageUrl}?lng=${language}`;
  return {
    canonical: inLanguage(locale),
    languages: { ...Object.fromEntries(SUPPORTED_LOCALES.map((language) => [intlLocale(language), inLanguage(language)])), "x-default": pageUrl },
  };
}

/** The page's title: the business's name, then its category and city when it has them. */
export function profileTitle(profile: Pick<PublicBusinessProfile, "name" | "category" | "address">, t: Translate): string {
  const { name, category } = profile;
  const city = profile.address?.city;
  if (category && city) return t("meta.title", { name, category, city });
  if (category) return t("meta.titleNoCity", { name, category });
  if (city) return t("meta.titleNoCategory", { name, city });
  return name;
}

const DESCRIPTION_LENGTH = 160;

/** The summary search results show: the business's description, cut at a word near 160 characters, or a line naming the business. */
export function profileDescription(profile: Pick<PublicBusinessProfile, "name" | "description">, t: Translate): string {
  const text = profile.description?.replace(/\s+/g, " ").trim();
  if (!text) return t("meta.description", { name: profile.name });
  if (text.length <= DESCRIPTION_LENGTH) return text;
  const cut = text.slice(0, DESCRIPTION_LENGTH - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > DESCRIPTION_LENGTH / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function format(locale: SupportedLocale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = formats.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(intlLocale(locale), options);
    formats.set(key, formatter);
  }
  return formatter;
}

function capitalize(value: string, locale: SupportedLocale): string {
  return value.charAt(0).toLocaleUpperCase(intlLocale(locale)) + value.slice(1);
}

/** A time of day, written "8:00 am" in English as the brand writes it, and the language's own way elsewhere. */
export function formatClock(date: Date, locale: SupportedLocale, timezone: string): string {
  return format(locale, { hour: "numeric", minute: "2-digit", timeZone: timezone }).formatToParts(date)
    .map((part) => (part.type === "dayPeriod" && locale === "en" ? part.value.toLowerCase() : part.value))
    .join("");
}

/** A time of day from minutes after midnight, as the hours table writes it. */
export function formatMinutes(minutes: number, locale: SupportedLocale): string {
  return formatClock(new Date(Date.UTC(2026, 0, 5) + minutes * 60_000), locale, "UTC");
}

/** The weekday's name, starting with a capital, for 0 (Sunday) to 6 (Saturday). */
export function weekdayName(dayOfWeek: number, locale: SupportedLocale): string {
  // 2026-01-04 was a Sunday.
  return capitalize(format(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + dayOfWeek))), locale);
}

function localDay(date: Date, timezone: string): DateTime {
  return DateTime.fromJSDate(date, { zone: timezone }).startOf("day");
}

/** Calendar days from today to the date, in the business's time zone. */
function daysAway(date: Date, clock: Pick<Clock, "now" | "timezone">): number {
  return Math.round(localDay(date, clock.timezone).diff(localDay(clock.now, clock.timezone), "days").days);
}

function weekday(date: Date, clock: Pick<Clock, "locale" | "timezone">): string {
  return format(clock.locale, { weekday: "long", timeZone: clock.timezone }).format(date);
}

/** "Wednesday, November 11", with the year only when it isn't this year. */
function dateLabel(date: Date, clock: Pick<Clock, "locale" | "timezone" | "now">): string {
  const sameYear = localDay(date, clock.timezone).year === localDay(clock.now, clock.timezone).year;
  return format(clock.locale, { weekday: "long", month: "long", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: clock.timezone }).format(date);
}

/** The day a start falls on, in a sentence: its weekday within the week, its date after that. */
function dayInSentence(date: Date, clock: Clock): string {
  return daysAway(date, clock) < 7 ? weekday(date, clock) : dateLabel(date, clock);
}

export type StatusLine = { open: boolean; label: string; detail: string | null };

/** "Open now · Closes 5:00 pm", or null when the business shows no hours. */
export function statusLine(profile: Pick<PublicBusinessProfile, "hours" | "closures">, clock: Clock): StatusLine | null {
  if (!profile.hours?.length) return null;
  const status = openStatus(profile.hours, profile.closures ?? [], clock.timezone, clock.now);
  if (!status.configured) return null;
  const at = status.openNow ? status.closesAt : status.opensAt;
  const verb = status.openNow ? "closes" : "opens";
  let detail: string | null = null;
  if (at) {
    const date = new Date(at);
    const time = formatClock(date, clock.locale, clock.timezone);
    const away = daysAway(date, clock);
    detail = away <= 0
      ? clock.t(`status.${verb}Today`, { time })
      : away === 1
        ? clock.t(`status.${verb}Tomorrow`, { time })
        : clock.t(`status.${verb}On`, { day: dayInSentence(date, clock), time });
  }
  return { open: status.openNow, label: clock.t(status.openNow ? "status.open" : "status.closed"), detail };
}

/** "Tomorrow, 8:00 am": when the next opening starts. */
export function nextOpeningLabel(startsAt: string, clock: Clock): string {
  const date = new Date(startsAt);
  const time = formatClock(date, clock.locale, clock.timezone);
  const away = daysAway(date, clock);
  if (away <= 0) return clock.t("nextOpening.today", { time });
  if (away === 1) return clock.t("nextOpening.tomorrow", { time });
  return clock.t("nextOpening.on", { day: capitalize(dayInSentence(date, clock), clock.locale), time });
}

/** How a visitor books: in the chat, by phone, or either. Null when the page offers neither. */
export function bookingHint(channels: { chat: boolean; phone: boolean }, t: Translate): string | null {
  if (channels.chat && channels.phone) return t("nextOpening.bookChatOrPhone");
  if (channels.chat) return t("nextOpening.bookChat");
  if (channels.phone) return t("nextOpening.bookPhone");
  return null;
}

export type HoursRow = { dayOfWeek: number; day: string; times: string[]; today: boolean };

// The table starts on Monday.
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** The week's hours, a row a day: each opening on its own line, or none when closed. */
export function hoursRows(hours: HoursWindow[], clock: Clock): HoursRow[] {
  const today = DateTime.fromJSDate(clock.now, { zone: clock.timezone }).weekday % 7;
  return WEEK.map((dayOfWeek) => ({
    dayOfWeek,
    day: weekdayName(dayOfWeek, clock.locale),
    today: dayOfWeek === today,
    times: hours
      .filter((window) => window.dayOfWeek === dayOfWeek)
      .sort((left, right) => left.openMinutes - right.openMinutes)
      .map((window) => window.openMinutes === 0 && window.closeMinutes >= 1440
        ? clock.t("hours.allDay")
        : clock.t("hours.range", { start: formatMinutes(window.openMinutes, clock.locale), end: formatMinutes(window.closeMinutes, clock.locale) })),
  }));
}

/** The business's time zone by its name in the page's language, such as "Pacific Time". */
export function timeZoneLabel(timezone: string, locale: SupportedLocale, now: Date): string | null {
  try {
    const name = format(locale, { timeZone: timezone, timeZoneName: "longGeneric" }).formatToParts(now).find((part) => part.type === "timeZoneName")?.value;
    return name ? capitalize(name, locale) : null;
  } catch {
    return null;
  }
}

export type ClosureLine = { when: string; reason: string };

/** When each closure is, whole days or part of one, with its reason. */
export function closureLines(closures: NonNullable<PublicBusinessProfile["closures"]>, clock: Clock): ClosureLine[] {
  return closures.map((closure) => {
    const start = DateTime.fromISO(closure.startsAt, { zone: clock.timezone });
    const end = DateTime.fromISO(closure.endsAt, { zone: clock.timezone });
    const date = (value: DateTime) => dateLabel(value.toJSDate(), clock);
    const time = (value: DateTime) => formatClock(value.toJSDate(), clock.locale, clock.timezone);
    let when: string;
    if (+start === +start.startOf("day") && +end === +end.startOf("day")) {
      const lastDay = end.minus({ days: 1 });
      when = lastDay <= start ? clock.t("closures.day", { date: date(start) }) : clock.t("closures.days", { start: date(start), end: date(lastDay) });
    } else if (start.hasSame(end, "day")) {
      when = clock.t("closures.partOfDay", { date: date(start), start: time(start), end: time(end) });
    } else {
      when = clock.t("closures.span", { startDate: date(start), startTime: time(start), endDate: date(end), endTime: time(end) });
    }
    return { when, reason: closure.reason.trim() };
  });
}

/** A service's name in the page's language, when the business gave one. */
export function serviceName(service: { name: string; localizedNames?: PublicProfileService["localizedNames"] | undefined }, locale: SupportedLocale): string {
  return (locale === "en" || locale === "fr" ? service.localizedNames?.[locale] : undefined) ?? service.name;
}

/**
 * The number as people near the business dial it, when its address is in the
 * number's country, and in international form otherwise.
 */
export function phoneDisplay(e164: string, countryCode: string | null | undefined): string {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed?.isValid()) return e164;
  const local = Boolean(countryCode && isSupportedCountry(countryCode) && getCountryCallingCode(countryCode) === parsed.countryCallingCode);
  return local ? parsed.formatNational() : parsed.formatInternational();
}

/** The address's lines as the page writes them: the street, then the city, region and postal code. */
export function addressLines(address: PublicProfileAddress): string[] {
  const locality = [address.city, [address.region, address.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [address.line1, address.line2, locality].filter((line): line is string => Boolean(line));
}

/** Links to the address in Google Maps, which need no key, and its embedded map, which does. */
export function mapLinks(address: PublicProfileAddress, input: { embedKey?: string | null; locale: SupportedLocale }) {
  const query = encodeURIComponent(formatPublicProfileAddress(address));
  const embedKey = input.embedKey?.trim();
  return {
    search: `https://www.google.com/maps/search/?api=1&query=${query}`,
    directions: `https://www.google.com/maps/dir/?api=1&destination=${query}`,
    embed: embedKey ? `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(embedKey)}&q=${query}&language=${intlLocale(input.locale)}` : null,
  };
}

/** The other languages the page offers: the one the top of the page suggests, and every other one. */
export function profileLanguages(current: SupportedLocale, businessLocale: SupportedLocale): { suggested: SupportedLocale; others: SupportedLocale[] } {
  const suggested = current !== businessLocale ? businessLocale : current === "en" ? "fr" : "en";
  return { suggested, others: SUPPORTED_LOCALES.filter((locale) => locale !== current) };
}

const SCHEMA_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function schemaTime(minutes: number): string {
  // Search engines read a day that ends at midnight as closing at 23:59.
  const value = Math.min(minutes, 1439);
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

/**
 * The page's summary for search engines, as schema.org's LocalBusiness, ready
 * for a JSON-LD script. Every "<" is escaped, so text from the business can't
 * end the script.
 */
export function localBusinessJsonLd(profile: PublicBusinessProfile, pageUrl: string): string {
  const address = profile.address;
  const data = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: profile.name,
    url: pageUrl,
    description: profile.description ?? undefined,
    telephone: profile.phone ?? undefined,
    email: profile.email ?? undefined,
    sameAs: profile.websiteUrl ? [profile.websiteUrl] : undefined,
    address: address ? {
      "@type": "PostalAddress",
      streetAddress: [address.line1, address.line2].filter(Boolean).join(", ") || undefined,
      addressLocality: address.city ?? undefined,
      addressRegion: address.region ?? undefined,
      postalCode: address.postalCode ?? undefined,
      addressCountry: address.countryCode ?? undefined,
    } : undefined,
    openingHoursSpecification: profile.hours?.length ? profile.hours.map((window) => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: SCHEMA_DAYS[window.dayOfWeek],
      opens: schemaTime(window.openMinutes),
      closes: schemaTime(window.closeMinutes),
    })) : undefined,
  };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
