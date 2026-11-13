import type { SupportedLocale } from "../locale";

/**
 * The interface languages the help pages are written in. A language joins
 * when its articles and words exist in the registry; until then its help
 * addresses go to English (the proxy and the help button both use this).
 */
export const HELP_LOCALES = ["en"] as const satisfies readonly SupportedLocale[];

export type HelpLocale = (typeof HELP_LOCALES)[number];

export const DEFAULT_HELP_LOCALE: HelpLocale = "en";

export function isHelpLocale(locale: string | null | undefined): locale is HelpLocale {
  return (HELP_LOCALES as readonly string[]).includes(locale ?? "");
}

/** The language a reader of this interface language gets help in. */
export function helpLocaleFor(locale: string | null | undefined): HelpLocale {
  return isHelpLocale(locale) ? locale : DEFAULT_HELP_LOCALE;
}

/** The address of the help index, or of one help page. */
export function helpPath(locale: string | null | undefined, slug?: string): string {
  return `/${helpLocaleFor(locale)}/help${slug ? `/${slug}` : ""}`;
}

/** The address of every help page in one Markdown file. */
export function helpMarkdownPath(locale: string | null | undefined): string {
  return `/${helpLocaleFor(locale)}/help.md`;
}
