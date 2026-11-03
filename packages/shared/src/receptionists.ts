// Several receptionists per business: the rules the database, the dashboard,
// the worker and the public pages share. A business always has exactly one
// default receptionist, the row it had before receptionists existed; it
// answers whatever names no receptionist, or one that is paused or archived.

import { normalizeRuntimeLocale, type InterfaceLocale, type RuntimeLocale } from "./locales";
import { publicProfilePath } from "./publicProfile";

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

/** Text entries the snapshot keeps for each receptionist, best first, for knowledge search and its prompt. */
export const MAX_SNIPPETS_PER_RECEPTIONIST = 50;

/** Documents each receptionist's knowledge digest lists, newest first, within its token budget. */
export const MAX_DIGEST_DOCUMENTS_PER_RECEPTIONIST = 40;

/** Longest website rule path, as migration 0136 allows. */
export const WEBSITE_RULE_PATH_MAX_LENGTH = 300;

/**
 * Who may use an article, as a receptionist sees it: its audience and, for a
 * chosen one, the receptionists it was chosen for that aren't archived.
 */
export type ArticleAudience = { audience?: KnowledgeAudience | undefined; receptionistIds?: readonly string[] | undefined };

/** What decides which articles a receptionist may use. */
export type AudienceReader = { id: string; isDefault: boolean; knowledgeScope: ReceptionistKnowledgeScope };

/**
 * Whether a receptionist may use an article. One whose scope is all, as the
 * default receptionist's is unless the owner limits it, uses every article.
 * Otherwise it uses the articles for everyone and those chosen for it. An
 * article chosen only for archived receptionists, or for none, is left to the
 * default receptionist, never to everyone. The search filter in SQL
 * (searchKnowledgeEvidence) follows the same rule.
 */
export function receptionistMayUse(receptionist: AudienceReader, article: ArticleAudience): boolean {
  if (receptionist.knowledgeScope === "all" || article.audience !== "chosen") return true;
  const chosen = article.receptionistIds ?? [];
  if (chosen.includes(receptionist.id)) return true;
  return receptionist.isDefault && chosen.length === 0;
}

/**
 * A website rule's path as the database keeps it: from the leading slash to a
 * trailing slash, so /stores/kitsilano covers /stores/kitsilano/hours but not
 * /stores/kitsilano-west. A full address keeps only its path. Null for a path
 * the rule can't use: a query, a fragment, a space, an empty segment or one
 * longer than 300 characters. The root, "/", covers the whole site.
 */
export function normalizeWebsiteRulePath(value: string): string | null {
  let path = value.trim();
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      if (url.search || url.hash) return null;
      path = url.pathname;
    } catch {
      return null;
    }
  }
  if (/[?#\s]/.test(path)) return null;
  if (!path.startsWith("/")) path = `/${path}`;
  if (!path.endsWith("/")) path = `${path}/`;
  if (path !== "/" && !/^\/([^/]+\/)+$/.test(path)) return null;
  return path.length <= WEBSITE_RULE_PATH_MAX_LENGTH ? path : null;
}

/**
 * Whether a website page falls under a rule: the same site as the rule's
 * source, and a path the rule's path starts. A site is its host and port,
 * with or without "www." and over HTTP or HTTPS, since a crawl can land on
 * either. Addresses are compared as the crawler saves them
 * (normalizeWebsiteSourceUrl): a page's path has no trailing slash, so
 * /stores/kitsilano itself is under /stores/kitsilano/.
 */
export function websitePageUnderRule(pageUrl: string, siteUrl: string, rulePath: string): boolean {
  let page: URL;
  let site: URL;
  try {
    page = new URL(pageUrl);
    site = new URL(siteUrl);
  } catch {
    return false;
  }
  const host = (url: URL) => url.host.toLowerCase().replace(/^www\./, "");
  if (host(page) !== host(site)) return false;
  const pagePath = page.pathname.endsWith("/") ? page.pathname : `${page.pathname}/`;
  return pagePath.startsWith(rulePath);
}

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

/**
 * Compares receptionists' names as people read them in the business's
 * language: accents and case aside, numbers by value ("Store 2" before
 * "Store 10"). Names alike compare equal, so a stable sort keeps their order.
 */
export function compareReceptionistNames(locale: string | null | undefined): (a: { name: string }, b: { name: string }) => number {
  const options: Intl.CollatorOptions = { sensitivity: "base", numeric: true };
  let collator: Intl.Collator;
  try {
    collator = new Intl.Collator(locale?.replace("_", "-") || undefined, options);
  } catch {
    collator = new Intl.Collator(undefined, options);
  }
  return (a, b) => collator.compare(a.name, b.name);
}

/**
 * Receptionists' ids by name after the default: Sort A–Z, and "Alphabetical"
 * on the business page. Names alike keep the order they come in, the list's.
 */
export function alphabeticalReceptionistOrder(receptionists: readonly { id: string; name: string; isDefault: boolean }[], locale: string | null | undefined): string[] {
  const others = receptionists.filter((receptionist) => !receptionist.isDefault).sort(compareReceptionistNames(locale));
  return [...receptionists.filter((receptionist) => receptionist.isDefault), ...others].map((receptionist) => receptionist.id);
}

/**
 * Whether receptionists, in the order the business lists them (the default
 * first), go by name. While they do, one added, restored or renamed takes its
 * place by name; once the owner moves one, the order is theirs and new ones
 * go last.
 */
export function isAlphabeticalReceptionistOrder(receptionists: readonly { id: string; name: string; isDefault: boolean }[], locale: string | null | undefined): boolean {
  return alphabeticalReceptionistOrder(receptionists, locale).every((id, index) => receptionists[index]?.id === id);
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

/** Most QR links a business keeps: a sign per door, desk and window of a chain's stores. Links are paused, never deleted. */
export const MAX_ENTRY_LINKS_PER_BUSINESS = 1_000;

/** The days a QR link's scan chart covers, as its "Scans, 30 days" count. */
export const ENTRY_LINK_CHART_DAYS = 30;

/** The address a QR link's sign carries. */
export function entryLinkPath(code: string): string {
  return `/q/${code}`;
}

/** A receptionist's page: the business page for the default receptionist, else a handle under it. */
export function receptionistPagePath(slug: string, handle: string | null | undefined): string {
  const page = publicProfilePath(slug);
  return handle ? `${page}/${encodeURIComponent(handle)}` : page;
}

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
