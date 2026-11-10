import type { Locale } from "@/i18n/config"
import { privacyEn } from "./privacy-en"
import { privacyEs } from "./privacy-es"
import { privacyFr } from "./privacy-fr"
import { privacySr } from "./privacy-sr"
import { termsEn } from "./terms-en"
import { termsEs } from "./terms-es"
import { termsFr } from "./terms-fr"
import { termsSr } from "./terms-sr"
import { legalProcessorOf } from "./processor"
import type { LegalDocument, LegalProcessor } from "./types"

export type LegalKind = "privacy" | "terms"

export type { LegalBlock, LegalDocument, LegalProcessor, LegalSection } from "./types"
export { legalProcessorOf, processorNames } from "./processor"

/** Every legal page in every language, naming the given payment processor. */
export const legalDocumentsFor = (
  processor: LegalProcessor
): Record<LegalKind, Record<Locale, LegalDocument>> => ({
  privacy: {
    en: privacyEn(processor),
    fr: privacyFr(processor),
    es: privacyEs(processor),
    sr: privacySr(processor),
  },
  terms: {
    en: termsEn(processor),
    fr: termsFr(processor),
    es: termsEs(processor),
    sr: termsSr(processor),
  },
})

/** The deployment's processor: the build's BILLING_PROVIDER, Polar when it's unset. */
export const legalProcessor = legalProcessorOf(import.meta.env.BILLING_PROVIDER)

export const legalDocuments = legalDocumentsFor(legalProcessor)

export const getLegalDocument = (kind: LegalKind, locale: Locale) =>
  legalDocuments[kind][locale]
