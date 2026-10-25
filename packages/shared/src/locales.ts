/**
 * Languages LobbyStack's interfaces are translated into: the dashboard, the
 * website widget, the landing site and transactional email. The short codes
 * are the identifiers used in URLs, cookies, storage and locale folders.
 *
 * This is separate from {@link RuntimeLocale}, the languages calls can open
 * in; the receptionist then follows the caller's language.
 */
export const interfaceLocales = ["en", "fr", "es", "sr"] as const;

export type InterfaceLocale = (typeof interfaceLocales)[number];

/**
 * BCP 47 tags to hand to `Intl`, Luxon, `<html lang>`, `hreflang` and
 * `Content-Language`. Serbian is written in Latin script only, and a bare `sr`
 * makes `Intl` format dates and numbers in Cyrillic, so it maps to `sr-Latn`.
 */
export const interfaceLocaleTags: Record<InterfaceLocale, string> = {
  en: "en",
  fr: "fr",
  es: "es",
  sr: "sr-Latn",
};

export function isInterfaceLocale(value: unknown): value is InterfaceLocale {
  return typeof value === "string" && (interfaceLocales as ReadonlyArray<string>).includes(value);
}

/** Reduces a language tag such as `es-MX` or `sr_Latn_RS` to a supported short code. */
export function normalizeInterfaceLocale(value: string | null | undefined): InterfaceLocale | null {
  if (!value) return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  return isInterfaceLocale(primary) ? primary : null;
}

/**
 * Returns the tag to format with for a short code or a full language tag.
 * Serbian always resolves to Latin script, keeping any region (`sr-RS` becomes
 * `sr-Latn-RS`). Other values pass through unchanged.
 */
export function intlLocale(value: string | null | undefined, fallback = "en"): string {
  const tag = value?.trim().replaceAll("_", "-");
  if (!tag) return fallback;
  const [language, ...rest] = tag.split("-");
  if (language?.toLowerCase() !== "sr") return tag;
  const region = rest.find((part) => /^(?:[a-z]{2}|\d{3})$/i.test(part));
  return region ? `sr-Latn-${region.toUpperCase()}` : "sr-Latn";
}

/**
 * Languages a call can open in. A business's default customer language is one
 * of them: GPT-Live speaks it until the caller speaks another language, and
 * call and business summaries are written in it. The dashboard lists them in
 * this order: English, then the six languages OpenAI improved in GPT-Live 1.1,
 * then the rest.
 */
export const runtimeLocales = ["en", "es", "fr", "de", "hi", "ja", "ko", "pt", "zh", "it", "uk", "ru", "ar"] as const;

export type RuntimeLocale = (typeof runtimeLocales)[number];

/** Each runtime language's English name, as instructions to a model name it. */
export const runtimeLocaleNames: Record<RuntimeLocale, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  hi: "Hindi",
  ja: "Japanese",
  ko: "Korean",
  pt: "Portuguese",
  zh: "Mandarin Chinese",
  it: "Italian",
  uk: "Ukrainian",
  ru: "Russian",
  ar: "Arabic",
};

/** Each runtime language's name in that language, as the dashboard lists it whatever its own language. */
export const runtimeLocaleEndonyms: Record<RuntimeLocale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  hi: "हिन्दी",
  ja: "日本語",
  ko: "한국어",
  pt: "Português",
  zh: "中文（普通话）",
  it: "Italiano",
  uk: "Українська",
  ru: "Русский",
  ar: "العربية",
};

export function isRuntimeLocale(value: unknown): value is RuntimeLocale {
  return typeof value === "string" && (runtimeLocales as ReadonlyArray<string>).includes(value);
}

/** Reduces a language tag such as `pt-BR` or `zh-Hans` to a runtime language, or null when calls can't open in it. */
export function normalizeRuntimeLocale(value: string | null | undefined): RuntimeLocale | null {
  if (!value) return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  return isRuntimeLocale(primary) ? primary : null;
}
