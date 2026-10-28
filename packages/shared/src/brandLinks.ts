import { currentBrand, type ResolvedBrand } from "./brands/resolve";

// Where the app sends people outside itself: the deployment's website, its
// terms and privacy policy, its docs, the address people write to, and its
// integrations on Zapier and Make.
//
// Each one comes from the deployment's brand file (brands/resolve.ts), and
// whatever the brand leaves out goes to LobbyStack's own, except Zapier and
// Make: a brand without its own integration there has none.

export const LOBBYSTACK_SITE_URL = "https://lobbystack.com";
export const LOBBYSTACK_DOCS_URL = "https://docs.lobbystack.com";

/** LobbyStack's address for each place the app gives one. A brand's contactEmail replaces all three. */
export const LOBBYSTACK_CONTACT_EMAILS = {
  /** The dashboard's feedback form. */
  support: "support@lobbystack.com",
  /** The Enterprise plan's contact button. */
  sales: "hello@lobbystack.ai",
  /** The SMS HELP replies, worded as LobbyStack registered them with carriers. */
  sms: "hello@lobbystack.com",
} as const;

export type ContactPurpose = keyof typeof LOBBYSTACK_CONTACT_EMAILS;

export type BrandLinks = {
  /** The website, without a trailing slash. */
  siteUrl: string;
  /** The terms of service, or null for the website's /terms page. */
  termsUrl: string | null;
  /** The privacy policy, or null for the website's /privacy page. */
  privacyUrl: string | null;
  /** The docs, without a trailing slash. */
  docsUrl: string;
  /** The one address for everything, or null for LobbyStack's address for each purpose. */
  contactEmail: string | null;
  /** The brand's integration on Zapier: its invite link while it's private, its page in Zapier's app directory once it's public; null for none. */
  zapierUrl: string | null;
  /** The invite link of the brand's app on Make, which Make gives once the app is published; null for none. */
  makeUrl: string | null;
};

function httpUrl(value: unknown): URL | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/** A site that links append paths to: an http or https URL with no query or fragment, without its trailing slash. */
export function normalizeSiteUrl(value: unknown): string | null {
  const url = httpUrl(value);
  return url && !url.search && !url.hash ? url.toString().replace(/\/+$/, "") : null;
}

/** One page's address: an http or https URL without credentials. */
export function normalizePageUrl(value: unknown): string | null {
  return httpUrl(value)?.toString() ?? null;
}

/** A page on Zapier's own site: an https URL on zapier.com or one of its subdomains. */
export function normalizeZapierUrl(value: unknown): string | null {
  const url = httpUrl(value);
  return url && url.protocol === "https:" && (url.hostname === "zapier.com" || url.hostname.endsWith(".zapier.com")) ? url.toString() : null;
}

/** A page on Make's own site: an https URL on make.com or one of its subdomains, such as eu1.make.com. */
export function normalizeMakeUrl(value: unknown): string | null {
  const url = httpUrl(value);
  return url && url.protocol === "https:" && (url.hostname === "make.com" || url.hostname.endsWith(".make.com")) ? url.toString() : null;
}

// Plain addresses only: anything else could end a mailto: link early or read
// oddly inside a text message.
const EMAIL_ADDRESS = /^[A-Za-z0-9._+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

export function normalizeEmailAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim();
  return address.length <= 254 && EMAIL_ADDRESS.test(address) ? address : null;
}

const NO_BRAND_LINKS: ResolvedBrand["links"] = { siteUrl: null, termsUrl: null, privacyUrl: null, docsUrl: null, contactEmail: null, zapierUrl: null, makeUrl: null };

/** Each link from the brand, else LobbyStack's, but Zapier's and Make's only from the brand. */
export function resolveBrandLinks(brand: ResolvedBrand["links"] = NO_BRAND_LINKS): BrandLinks {
  return {
    siteUrl: brand.siteUrl ?? LOBBYSTACK_SITE_URL,
    termsUrl: brand.termsUrl,
    privacyUrl: brand.privacyUrl,
    docsUrl: brand.docsUrl ?? LOBBYSTACK_DOCS_URL,
    contactEmail: brand.contactEmail,
    // LobbyStack's own Zapier integration connects to LobbyStack's hosted
    // dashboard, never this deployment, so there's no fallback. A Make app
    // calls the one dashboard it was built for, so the same goes for Make.
    zapierUrl: brand.zapierUrl,
    makeUrl: brand.makeUrl,
  };
}

/** Where this deployment's outside links go. */
export function brandLinks(): BrandLinks {
  return resolveBrandLinks(currentBrand().links);
}

/** The address to give for one purpose: the deployment's own, else LobbyStack's for that purpose. */
export function contactEmailFor(links: Pick<BrandLinks, "contactEmail">, purpose: ContactPurpose): string {
  return links.contactEmail ?? LOBBYSTACK_CONTACT_EMAILS[purpose];
}
