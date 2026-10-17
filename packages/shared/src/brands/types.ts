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

export type BrandDefinition = {
  id: string;
  appName: string;
  /** The logo's URL on the admin, versioned by its content, or null for none. */
  logoUrl: string | null;
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
  /** The brand a deployment gets when no brand claims its domain. */
  default: string;
  /** Apex domain, such as alloplace.com, to brand id. */
  domains: Record<string, string>;
};
