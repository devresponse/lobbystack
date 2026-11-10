import { describe, expect, it } from "vitest"
import { SUPPORTED_LOCALES, type Locale } from "@/i18n/config"
import {
  legalDocuments,
  legalDocumentsFor,
  legalProcessorOf,
  processorNames,
  type LegalBlock,
  type LegalDocument,
  type LegalKind,
  type LegalProcessor,
} from "@/lib/legal"

const kinds = Object.keys(legalDocuments) as LegalKind[]
const translatedLocales = SUPPORTED_LOCALES.filter((locale) => locale !== "en")
const processors: LegalProcessor[] = ["polar", "stripe"]

const shape = (block: LegalBlock) =>
  typeof block === "string"
    ? "p"
    : "h3" in block
      ? "h3"
      : `ul:${block.ul.length}`

const allText = (kind: LegalKind, locale: Locale) =>
  documentText(legalDocuments[kind][locale])

const documentText = (doc: LegalDocument) => {
  return [
    doc.intro,
    ...doc.sections.flatMap((section) => [
      section.title,
      ...section.blocks.flatMap((block) =>
        typeof block === "string"
          ? [block]
          : "h3" in block
            ? [block.h3]
            : block.ul
      ),
    ]),
  ].join("\n")
}

describe("legal documents", () => {
  describe.each(translatedLocales)("%s", (locale) => {
    it.each(kinds)("keeps the %s version in parity with English", (kind) => {
      const { en } = legalDocuments[kind]
      const translated = legalDocuments[kind][locale]

      expect(translated.sections.map((section) => section.id)).toEqual(
        en.sections.map((section) => section.id)
      )
      for (const [index, section] of en.sections.entries()) {
        expect(translated.sections[index]!.blocks.map(shape)).toEqual(
          section.blocks.map(shape)
        )
      }
    })

    it.each(kinds)("keeps em dashes out of %s", (kind) => {
      expect(allText(kind, locale)).not.toContain("—")
    })

    it.each(kinds)("links %s pages to localized routes", (kind) => {
      const text = allText(kind, locale)
      for (const path of ["/privacy/", "/pricing/", "/cookie-policy/"]) {
        expect(text).not.toContain(`href="${path}`)
      }
    })
  })

  it.each(kinds)("uses unique section anchors in %s", (kind) => {
    const ids = legalDocuments[kind].en.sections.map((section) => section.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(kinds)("keeps em dashes out of the English %s", (kind) => {
    expect(allText(kind, "en")).not.toContain("—")
  })

  it.each(kinds)("writes the Serbian %s in Latin script", (kind) => {
    expect(allText(kind, "sr")).not.toMatch(/[Ѐ-ӿ]/)
  })
})

// The landing build names the deployment's payment processor, from BILLING_PROVIDER.
describe.each(processors)("legal documents naming %s", (processor) => {
  const documents = legalDocumentsFor(processor)
  const other = processor === "polar" ? "Stripe" : "Polar"

  it.each(kinds)("name only that processor in every language's %s", (kind) => {
    for (const locale of SUPPORTED_LOCALES) {
      const text = documentText(documents[kind][locale])
      expect(text).toContain(processorNames[processor])
      expect(text).not.toContain(other)
    }
  })

  it.each(kinds)("keep every language's %s in parity with English", (kind) => {
    const { en } = documents[kind]
    for (const locale of translatedLocales) {
      const translated = documents[kind][locale]
      for (const [index, section] of en.sections.entries()) {
        expect(translated.sections[index]!.blocks.map(shape)).toEqual(
          section.blocks.map(shape)
        )
      }
      expect(documentText(translated)).not.toContain("—")
    }
  })
})

describe("the payment processor", () => {
  const clause = (processor: LegalProcessor, locale: Locale) =>
    legalDocumentsFor(processor)
      .terms[locale].sections.flatMap((section) => section.blocks)
      .find(
        (block): block is string =>
          typeof block === "string" && block.startsWith("12.2 ")
      )

  it("says in 12.2 that Polar resells, and that with Stripe the operator sells", () => {
    expect(clause("polar", "en")).toContain("You authorize us and Polar")
    expect(clause("stripe", "en")).toContain("We are the seller")
    for (const locale of translatedLocales) {
      expect(clause("stripe", locale)).not.toBe(
        clause("polar", locale)?.replaceAll("Polar", "Stripe")
      )
    }
  })

  it("comes from BILLING_PROVIDER, Polar unless it says stripe", () => {
    expect(legalProcessorOf("stripe")).toBe("stripe")
    expect(legalProcessorOf(" Stripe ")).toBe("stripe")
    expect(legalProcessorOf("polar")).toBe("polar")
    expect(legalProcessorOf(undefined)).toBe("polar")
    expect(legalProcessorOf("")).toBe("polar")
  })
})
