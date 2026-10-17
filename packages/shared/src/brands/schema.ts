import { createHash } from "node:crypto";

import { z } from "zod";

import { MAX_APP_NAME_LENGTH, brandLogoContentType, normalizeAccentColor, normalizeAppName } from "../branding";
import { normalizeEmailAddress, normalizePageUrl, normalizeSiteUrl } from "../brandLinks";
import type { BrandDefinition, BrandIndex } from "./types";

// The files under brands/ and how `pnpm brands:build` turns them into
// generated.ts. Only the build script and tests import this module, so the
// apps never ship zod's checks for files that can't change at run time.

const BRAND_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
// A lowercase apex such as alloplace.com or realinfobot.co.uk, in punycode.
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const ENVIRONMENT_PATTERN = /^[a-z0-9-]+\*?$/;
const ASSET_NAME = /^[a-z0-9][a-z0-9._-]*\.(?:svg|png|jpg|jpeg|webp)$/;

const checked = (normalize: (value: unknown) => string | null, message: string) => z.string().refine((value) => normalize(value) !== null, message);

export const brandIndexSchema = z.strictObject({
  $schema: z.string().optional(),
  default: z.string().regex(BRAND_ID, "a brand id: lowercase letters, digits and dashes"),
  domains: z.record(z.string().regex(DOMAIN, "a lowercase apex domain such as alloplace.com"), z.string().regex(BRAND_ID)),
});

export const brandFileSchema = z.strictObject({
  $schema: z.string().optional(),
  appName: checked(normalizeAppName, `1 to ${MAX_APP_NAME_LENGTH} visible characters`),
  logo: z.string().regex(ASSET_NAME, "a file in the brand's folder: .svg, .png, .jpg or .webp").optional(),
  accentColor: checked(normalizeAccentColor, "a #rgb or #rrggbb colour").optional(),
  links: z.strictObject({
    site: checked(normalizeSiteUrl, "an http or https URL with no query or fragment").optional(),
    terms: checked(normalizePageUrl, "an http or https URL").optional(),
    privacy: checked(normalizePageUrl, "an http or https URL").optional(),
    docs: checked(normalizeSiteUrl, "an http or https URL with no query or fragment").optional(),
  }).optional(),
  contactEmail: checked(normalizeEmailAddress, "a plain email address").optional(),
  environments: z.record(
    z.string().regex(ENVIRONMENT_PATTERN, "a host label such as staging, or a prefix such as dev*"),
    z.strictObject({
      appNameSuffix: z.string().optional(),
      indexing: z.boolean().optional(),
    }),
  ).optional(),
});

export type BrandFile = z.infer<typeof brandFileSchema>;

/** What the build read: index.json, and each folder's brand.json and image files. */
export type BrandSources = {
  index: unknown;
  brands: Record<string, { file: unknown; assets: Record<string, Uint8Array> }>;
};

export type CompiledBrands = {
  index: BrandIndex;
  brands: Record<string, BrandDefinition>;
  /** The files the admin serves, by their path under its public folder. */
  publicAssets: Record<string, Uint8Array>;
};

/** Where the admin serves a brand's files, under apps/admin/public. */
export function brandAssetPath(id: string, name: string): string {
  return `/brand/${id}/${name}`;
}

function issues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => `${prefix}${issue.path.length ? ` ${issue.path.join(".")}` : ""}: ${issue.message}`);
}

/**
 * Checks every brand and compiles them for generated.ts. Throws one error that
 * lists every problem, so a broken brand never reaches a build.
 */
export function compileBrands(sources: BrandSources): CompiledBrands {
  const errors: string[] = [];
  const index = brandIndexSchema.safeParse(sources.index);
  if (!index.success) errors.push(...issues("brands/index.json", index.error));
  const brands: Record<string, BrandDefinition> = {};
  const publicAssets: Record<string, Uint8Array> = {};
  for (const id of Object.keys(sources.brands).sort()) {
    const where = `brands/${id}/brand.json`;
    if (!BRAND_ID.test(id)) {
      errors.push(`brands/${id}: a folder name must be lowercase letters, digits and dashes`);
      continue;
    }
    const parsed = brandFileSchema.safeParse(sources.brands[id]!.file);
    if (!parsed.success) {
      errors.push(...issues(where, parsed.error));
      continue;
    }
    const file = parsed.data;
    let logoUrl: string | null = null;
    if (file.logo) {
      const bytes = sources.brands[id]!.assets[file.logo];
      if (!bytes) errors.push(`${where} logo: brands/${id}/${file.logo} does not exist`);
      else if (!brandLogoContentType(bytes)) errors.push(`${where} logo: brands/${id}/${file.logo} must be a PNG, JPEG, WebP or a plain SVG of 256 KB or less`);
      else {
        const path = brandAssetPath(id, file.logo);
        publicAssets[path] = bytes;
        logoUrl = `${path}?v=${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`;
      }
    }
    const environments = Object.entries(file.environments ?? {}).map(([pattern, settings]) => ({
      pattern,
      appNameSuffix: settings.appNameSuffix ?? null,
      indexing: settings.indexing ?? true,
    }));
    for (const environment of environments) {
      if (environment.appNameSuffix !== null && normalizeAppName(`${file.appName}${environment.appNameSuffix}`) === null) {
        errors.push(`${where} environments.${environment.pattern}.appNameSuffix: the name with it must stay within ${MAX_APP_NAME_LENGTH} visible characters`);
      }
    }
    brands[id] = {
      id,
      appName: normalizeAppName(file.appName)!,
      logoUrl,
      accentColor: file.accentColor ? normalizeAccentColor(file.accentColor) : null,
      links: {
        siteUrl: file.links?.site ? normalizeSiteUrl(file.links.site) : null,
        termsUrl: file.links?.terms ? normalizePageUrl(file.links.terms) : null,
        privacyUrl: file.links?.privacy ? normalizePageUrl(file.links.privacy) : null,
        docsUrl: file.links?.docs ? normalizeSiteUrl(file.links.docs) : null,
        contactEmail: file.contactEmail ? normalizeEmailAddress(file.contactEmail) : null,
      },
      environments,
    };
  }
  if (index.success) {
    if (!sources.brands[index.data.default]) errors.push(`brands/index.json default: no folder brands/${index.data.default}`);
    for (const [domain, id] of Object.entries(index.data.domains)) {
      if (!sources.brands[id]) errors.push(`brands/index.json domains.${domain}: no folder brands/${id}`);
      // A claim on a subdomain of another claim would split one apex between brands.
      for (const other of Object.keys(index.data.domains)) {
        if (other !== domain && domain.endsWith(`.${other}`)) errors.push(`brands/index.json domains.${domain}: already covered by ${other}`);
      }
    }
  }
  if (errors.length) throw new Error(`Brand files have problems:\n- ${errors.join("\n- ")}`);
  const { default: defaultId, domains } = index.data!;
  return { index: { default: defaultId, domains: Object.fromEntries(Object.entries(domains).sort(([a], [b]) => a.localeCompare(b))) }, brands, publicAssets };
}

/** generated.ts for compiled brands. */
export function brandsModuleSource(compiled: Pick<CompiledBrands, "index" | "brands">): string {
  return [
    "// Generated by `pnpm brands:build` from the files under brands/. Do not edit.",
    "",
    'import type { BrandDefinition, BrandIndex } from "./types";',
    "",
    `export const BRAND_INDEX: BrandIndex = ${JSON.stringify(compiled.index, null, 2)};`,
    "",
    `export const BRANDS: Record<string, BrandDefinition> = ${JSON.stringify(compiled.brands, null, 2)};`,
    "",
  ].join("\n");
}

/** JSON Schemas for editors, from the same checks. */
export function brandJsonSchemas(): { brand: unknown; index: unknown } {
  return { brand: z.toJSONSchema(brandFileSchema, { io: "input" }), index: z.toJSONSchema(brandIndexSchema, { io: "input" }) };
}
