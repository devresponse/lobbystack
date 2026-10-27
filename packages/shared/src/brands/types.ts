// A brand as `pnpm brands:build` compiles it from brands/<id>/brand.json.
// Every value has already passed the checks the matching environment variable
// gets (branding.ts and brandLinks.ts), so code can use it as it stands.

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
  };
  environments: BrandEnvironment[];
};

export type BrandIndex = {
  /**
   * The brand a deployment gets when nothing picks another: no brand claims its
   * domain, BRAND_PRESET names none, and there isn't exactly one other brand.
   */
  default: string;
  /** Apex domain, such as alloplace.com, to brand id. */
  domains: Record<string, string>;
};
