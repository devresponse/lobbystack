// A brand as `pnpm brands:build` compiles it from brands/<id>/brand.json.
// Every value has already passed the checks the matching environment variable
// gets (branding.ts and brandLinks.ts), so code can use it as it stands.

import type { BillingDisplay } from "../billingDisplay";
import type { BillingAccounts, BillingPlanTier, ResolvedBillingPlan } from "../billingProfile";
import type { InterfaceLocale } from "../locales";

/** Settings for hosts whose first label matches a pattern, such as dev01 for "dev*". */
export type BrandEnvironment = {
  /** "dev*" matches any first label that starts with dev; anything else matches exactly. */
  pattern: string;
  /** Added to the name, as in "AlloPlace (dev)". */
  appNameSuffix: string | null;
  /** False keeps search engines away from every page. */
  indexing: boolean;
};

/** A PNG a brand serves from the admin: its URL, versioned by its content, and its size in pixels. */
export type BrandImage = { url: string; width: number; height: number };

/** Words in every interface language. */
export type BrandText = Record<InterfaceLocale, string>;

/**
 * The brand's panel on the sign-in, sign-up and other signed-out pages. Each
 * part the brand file leaves out is null, and the pages show the shared words
 * in its place.
 */
export type BrandSignInPage = {
  /** "accent" fills the panel with the accent colour; "dark" makes it near-black with touches of the accent, in light mode too. */
  panel: "accent" | "dark";
  headline: BrandText | null;
  /** The sentence under the headline. */
  description: BrandText | null;
  /** Three short points, listed under the sentence. */
  points: BrandText[] | null;
};

export type BrandDefinition = {
  id: string;
  appName: string;
  /** The logo's URL on the admin, versioned by its content, or null for none. */
  logoUrl: string | null;
  /** The logo emails show above the name, since mail clients don't show SVG, or null for the name alone. */
  emailLogo: BrandImage | null;
  /** The picture link previews show for the admin's pages, or null for none. */
  ogImage: BrandImage | null;
  /** #rrggbb in lowercase. */
  accentColor: string | null;
  links: {
    siteUrl: string | null;
    termsUrl: string | null;
    privacyUrl: string | null;
    docsUrl: string | null;
    contactEmail: string | null;
    zapierUrl: string | null;
    makeUrl: string | null;
  };
  environments: BrandEnvironment[];
  signInPage: BrandSignInPage;
};

/**
 * One of the four standard plans of a brand's billing.json, as the row an
 * apply writes for it, under the columns' own names, with its prices. A
 * deployment shows and enforces these until its first catalog apply.
 */
export type BrandBillingPlan = Pick<ResolvedBillingPlan, "sold" | "custom" | "overage" | "voice_sec" | "sms_seg" | "calls_out" | "chat_units" | "kb_bytes" | "numbers" | "receptionists" | "voice_rate" | "sms_rate" | "call_rate" | "sort" | "prices"> & { code: BillingPlanTier };

export type BrandIndex = {
  /**
   * The brand a deployment gets when nothing picks another: no brand claims its
   * domain, BRAND_PRESET names none, and there isn't exactly one other brand.
   */
  default: string;
  /** Apex domain, such as alloplace.com, to brand id. */
  domains: Record<string, string>;
};

/** A brand's billing.json display section: the plan screens' words and layout, which sell nothing. */
export type BrandPlanDisplay = BillingDisplay;

/** A brand's billing.json accounts section: rules for each account, such as how many businesses one may own, which the hash leaves out. */
export type BrandAccountLimits = BillingAccounts;
