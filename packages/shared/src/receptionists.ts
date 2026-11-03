// Several receptionists per business: the rules the database, the dashboard,
// the worker and the public pages share. A business always has exactly one
// default receptionist, the row it had before receptionists existed; it
// answers whatever names no receptionist, or one that is paused or archived.

import { normalizeRuntimeLocale, type InterfaceLocale, type RuntimeLocale } from "./locales";

/** Longest receptionist name. */
export const RECEPTIONIST_NAME_MAX_LENGTH = 80;

/** Longest "What it helps with" line. */
export const RECEPTIONIST_DESCRIPTION_MAX_LENGTH = 160;

/** Longest page handle, the last part of /profile/<slug>/<handle>. */
export const RECEPTIONIST_HANDLE_MAX_LENGTH = 60;

/** A page handle: lower-case letters and digits in groups joined by single dashes, as migration 0133 checks. */
export const RECEPTIONIST_HANDLE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** What a receptionist answers from: every article, or the articles for everyone plus those chosen for it. */
export const receptionistKnowledgeScopes = ["all", "audience"] as const;
export type ReceptionistKnowledgeScope = (typeof receptionistKnowledgeScopes)[number];

/** A receptionist that isn't archived is active or paused; a paused one's entry points answer as the default. */
export const receptionistStatuses = ["active", "paused"] as const;
export type ReceptionistStatus = (typeof receptionistStatuses)[number];

/** Who may use an article: every receptionist, or only the ones chosen for it. */
export const knowledgeAudiences = ["everyone", "chosen"] as const;
export type KnowledgeAudience = (typeof knowledgeAudiences)[number];

/** The deployment cap MAX_RECEPTIONISTS_PER_BUSINESS falls back to: the most receptionists any business may have, whatever its plan. */
export const DEFAULT_MAX_RECEPTIONISTS_PER_BUSINESS = 50;

/** The highest cap a deployment may set; billing.json's plans stay at 50 or fewer. */
export const MAX_RECEPTIONISTS_PER_BUSINESS_CEILING = 500;

/** Other receptionists a prompt names, in the order the Receptionists page sets, so a long list doesn't cost tokens on every turn. */
export const MAX_OTHER_RECEPTIONISTS_IN_PROMPT = 12;

/** From this many receptionists, dropdowns and multiselect boxes show a search field. */
export const RECEPTIONIST_PICKER_SEARCH_FROM = 8;

/** Most receptionists one Available to change or one listing order sends. */
export const MAX_RECEPTIONISTS_PER_REQUEST = MAX_RECEPTIONISTS_PER_BUSINESS_CEILING;

/** Articles one bulk Available to change may name. */
export const MAX_ARTICLES_PER_AUDIENCE_CHANGE = 500;

/**
 * The default receptionist's name in each language calls and the dashboard
 * use. Migration 0133 names each business's existing receptionist from this
 * list, and a test keeps the two the same.
 */
export const DEFAULT_RECEPTIONIST_NAMES = {
  en: "Front desk",
  es: "Recepción",
  fr: "Accueil",
  de: "Empfang",
  hi: "रिसेप्शन",
  ja: "受付",
  ko: "안내 데스크",
  pt: "Recepção",
  zh: "前台",
  it: "Accoglienza",
  uk: "Рецепція",
  ru: "Ресепшен",
  ar: "الاستقبال",
  sr: "Recepcija",
} as const satisfies Record<RuntimeLocale | InterfaceLocale, string>;

/** "Front desk" in a business's language, English for a language without a name. */
export function defaultReceptionistName(locale: string | null | undefined): string {
  const primary = locale?.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (Object.hasOwn(DEFAULT_RECEPTIONIST_NAMES, primary)) return DEFAULT_RECEPTIONIST_NAMES[primary as keyof typeof DEFAULT_RECEPTIONIST_NAMES];
  return DEFAULT_RECEPTIONIST_NAMES.en;
}

/** Whether a value can be a receptionist's page handle. */
export function isReceptionistHandle(value: string): boolean {
  return value.length <= RECEPTIONIST_HANDLE_MAX_LENGTH && RECEPTIONIST_HANDLE_PATTERN.test(value);
}

/**
 * A page handle made from a name: accents dropped, everything but letters and
 * digits turned into single dashes, cut at a dash to fit. A name with no
 * letter or digit in the Latin alphabet, such as 受付, gives "receptionist",
 * which the caller numbers when it is taken.
 */
export function receptionistHandleFrom(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[æ]/g, "ae")
    .replace(/[œ]/g, "oe")
    .replace(/[ø]/g, "o")
    .replace(/[đð]/g, "d")
    .replace(/[ł]/g, "l")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!ascii) return "receptionist";
  if (ascii.length <= RECEPTIONIST_HANDLE_MAX_LENGTH) return ascii;
  const cut = ascii.slice(0, RECEPTIONIST_HANDLE_MAX_LENGTH);
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, "");
}

/**
 * A handle that isn't taken: the handle itself, else the handle with the
 * lowest free number after it ("kitsilano-2"), cut so the number fits.
 */
export function availableReceptionistHandle(handle: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(handle)) return handle;
  for (let number = 2; ; number += 1) {
    const suffix = `-${number}`;
    const base = handle.slice(0, RECEPTIONIST_HANDLE_MAX_LENGTH - suffix.length).replace(/-+$/g, "");
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Up to two initials for a receptionist's badge: the first letters of its first two words. */
export function receptionistInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? "");
  return letters.join("").toLocaleUpperCase() || "?";
}

/**
 * The deployment's cap on receptionists per business, from
 * MAX_RECEPTIONISTS_PER_BUSINESS: a whole number from 1 to 500, else 50.
 */
export function maxReceptionistsPerBusiness(env: Record<string, string | undefined>): number {
  const raw = env.MAX_RECEPTIONISTS_PER_BUSINESS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_MAX_RECEPTIONISTS_PER_BUSINESS;
  const value = Number(raw);
  return value >= 1 && value <= MAX_RECEPTIONISTS_PER_BUSINESS_CEILING ? value : DEFAULT_MAX_RECEPTIONISTS_PER_BUSINESS;
}

/**
 * How many receptionists a business may have active at once, the default one
 * included; paused and archived ones don't count. Its plan's number, or the
 * deployment's cap for a plan without one (custom plans and self-hosting),
 * never more than the cap.
 */
export function receptionistAllowance(planIncluded: number | null | undefined, cap: number): number {
  const included = planIncluded === null || planIncluded === undefined ? cap : planIncluded;
  return Math.max(1, Math.min(included, cap));
}

/** The language a receptionist's calls open in: its own when set and supported, else the business's. */
export function receptionistLocale(receptionistLocaleValue: string | null | undefined, businessLocale: RuntimeLocale): RuntimeLocale {
  return normalizeRuntimeLocale(receptionistLocaleValue) ?? businessLocale;
}

/**
 * QR short links, /q/<code>. Codes use lower-case letters and digits without
 * the ones people mix up (i, l, o, 0 and 1), six of them by default: about
 * 887 million codes, and a sign's address stays short enough for a logo in
 * the middle of its QR code.
 */
export const ENTRY_LINK_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const ENTRY_LINK_CODE_LENGTH = 6;

/** Longest label on a link, such as "Front window". */
export const ENTRY_LINK_LABEL_MAX_LENGTH = 80;

/** Months of daily scan counts kept for the chart; the privacy sweep deletes older days. */
export const ENTRY_LINK_SCAN_RETENTION_MONTHS = 13;

/** A link status: a paused link opens the default receptionist. */
export const entryLinkStatuses = ["active", "paused"] as const;
export type EntryLinkStatus = (typeof entryLinkStatuses)[number];

/** A code as a scan sends it, trimmed and lower-cased; null when it can't be a code (migration 0140 allows 4 to 12 letters and digits). */
export function normalizeEntryLinkCode(value: string | null | undefined): string | null {
  const code = value?.trim().toLowerCase() ?? "";
  return /^[a-z0-9]{4,12}$/.test(code) ? code : null;
}

/** A new code from the alphabet, drawn with the random integers given (crypto's randomInt on the server). */
export function entryLinkCode(randomIndex: (size: number) => number, length = ENTRY_LINK_CODE_LENGTH): string {
  let code = "";
  for (let index = 0; index < length; index += 1) code += ENTRY_LINK_CODE_ALPHABET[randomIndex(ENTRY_LINK_CODE_ALPHABET.length)];
  return code;
}
