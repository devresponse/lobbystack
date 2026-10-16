import i18next from "i18next";
import { DEFAULT_APP_NAME } from "@lobbystack/shared";

import { resourcesForRoute } from "./i18n-resources";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from "./locale";

export type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Translations for a page rendered on the server that ships no translation
 * code to the browser, such as a business's profile page. Missing strings fall
 * back to English. React escapes the text it renders, so values aren't escaped
 * here.
 */
export function serverTranslator(locale: SupportedLocale, namespace: string, appName: string = DEFAULT_APP_NAME): Translate {
  const instance = i18next.createInstance();
  void instance.init({
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALES,
    ns: [namespace],
    defaultNS: namespace,
    resources: {
      [DEFAULT_LOCALE]: resourcesForRoute(DEFAULT_LOCALE, [namespace]),
      [locale]: resourcesForRoute(locale, [namespace]),
    },
    interpolation: { escapeValue: false, defaultVariables: { appName } },
    returnNull: false,
    initAsync: false,
  });
  const translate = instance.getFixedT(locale, namespace);
  return (key, values) => translate(key, values ?? {});
}
