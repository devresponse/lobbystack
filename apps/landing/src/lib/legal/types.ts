/**
 * One block of legal copy. A string is a paragraph, `h3` is a subheading, and
 * `ul` is a bulleted list. Strings may contain trusted inline HTML (links,
 * `<strong>`), which the page renders with `set:html`.
 */
export type LegalBlock = string | { h3: string } | { ul: string[] }

export interface LegalSection {
  id: string
  /** Short label for the sidebar navigation. */
  nav: string
  title: string
  blocks: LegalBlock[]
}

/** The payment processor the pages name: the deployment's billing provider, from the landing build's BILLING_PROVIDER. */
export type LegalProcessor = "polar" | "stripe"

export interface LegalDocument {
  updated: string
  h1: string
  intro: string
  notice?: string
  sections: LegalSection[]
}
