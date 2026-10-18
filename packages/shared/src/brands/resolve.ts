import { BRAND_INDEX, BRANDS } from "./generated";
import type { BrandDefinition, BrandImage, BrandIndex } from "./types";

// Which brand a deployment shows. A deployment knows its own address
// (APP_BASE_URL), and the domain it sits under picks the brand from
// brands/index.json, so dev01.alloplace.com and demo.alloplace.com are both
// AlloPlace. BRAND_PRESET names a brand only where no brand claims the domain,
// such as localhost or a *.up.railway.app address. Anything else gets the
// default brand, LobbyStack.

/** How the brand was chosen: the domain, BRAND_PRESET, or neither. */
export type BrandSource = "apex" | "preset" | "default";

export type ResolvedBrand = Omit<BrandDefinition, "environments"> & {
  source: BrandSource;
  /** The host of APP_BASE_URL, or null when it isn't a URL. */
  host: string | null;
  /** The scheme, host and port of APP_BASE_URL, for absolute links such as an email's logo. */
  origin: string | null;
  /** The claimed domain the host sits under, when a brand claims it. */
  domain: string | null;
  /** False on a host whose environment settings keep search engines away. */
  indexing: boolean;
  /** A BRAND_PRESET set on a claimed domain, which the domain overrides. */
  ignoredPreset: string | null;
  /** A BRAND_PRESET that names no brand. */
  unknownPreset: string | null;
};

export type BrandData = { index: BrandIndex; brands: Record<string, BrandDefinition> };

const GENERATED: BrandData = { index: BRAND_INDEX, brands: BRANDS };

function parseBaseUrl(appBaseUrl: string | null | undefined): URL | null {
  if (!appBaseUrl?.trim()) return null;
  try {
    return new URL(appBaseUrl.trim());
  } catch {
    return null;
  }
}

/** The lowercase host of a URL, without a trailing dot, or null when the value isn't a URL. */
export function brandHost(appBaseUrl: string | null | undefined): string | null {
  return parseBaseUrl(appBaseUrl)?.hostname.toLowerCase().replace(/\.$/, "") || null;
}

function brandOrigin(appBaseUrl: string | null | undefined): string | null {
  const url = parseBaseUrl(appBaseUrl);
  return url && (url.protocol === "https:" || url.protocol === "http:") ? url.origin : null;
}

/**
 * The claimed domain a host sits under, matched whole label by label, so
 * dev01.alloplace.com matches alloplace.com and notalloplace.com does not.
 */
export function claimedDomain(host: string, domains: Record<string, string>): string | null {
  const labels = host.split(".");
  for (let start = 0; start < labels.length - 1; start += 1) {
    const candidate = labels.slice(start).join(".");
    if (Object.hasOwn(domains, candidate)) return candidate;
  }
  return null;
}

function matchesLabel(pattern: string, label: string): boolean {
  return pattern.endsWith("*") ? label.startsWith(pattern.slice(0, -1)) : label === pattern;
}

/** The brand for a deployment's address and BRAND_PRESET. */
export function resolveBrand(input: { appBaseUrl?: string | null | undefined; preset?: string | null | undefined }, data: BrandData = GENERATED): ResolvedBrand {
  const host = brandHost(input.appBaseUrl);
  const domain = host ? claimedDomain(host, data.index.domains) : null;
  const preset = input.preset?.trim() || null;
  let id = data.index.default;
  let source: BrandSource = "default";
  if (domain) {
    id = data.index.domains[domain]!;
    source = "apex";
  } else if (preset && Object.hasOwn(data.brands, preset)) {
    id = preset;
    source = "preset";
  }
  const { environments, ...brand } = data.brands[id]!;
  // Only a subdomain of the claimed domain has a first label to match: dev01 in dev01.alloplace.com.
  const label = domain && host !== domain ? host!.split(".")[0]! : null;
  const environment = label === null ? undefined : environments.find((candidate) => matchesLabel(candidate.pattern, label));
  return {
    ...brand,
    appName: environment?.appNameSuffix ? `${brand.appName}${environment.appNameSuffix}` : brand.appName,
    source,
    host,
    origin: brandOrigin(input.appBaseUrl),
    domain,
    indexing: environment?.indexing ?? true,
    ignoredPreset: domain && preset ? preset : null,
    unknownPreset: !domain && preset && source !== "preset" ? preset : null,
  };
}

/**
 * One of the brand's images with an absolute URL under the deployment's
 * address, as emails and link previews need, or null when either is missing.
 */
export function brandImage(brand: Pick<ResolvedBrand, "origin">, image: BrandImage | null): BrandImage | null {
  return image && brand.origin ? { ...image, url: new URL(image.url, brand.origin).toString() } : null;
}

/** Whether a brand file decides the name and logo, rather than onboarding's saved choice. */
export function brandFileMatched(brand: Pick<ResolvedBrand, "source">): boolean {
  return brand.source !== "default";
}

/**
 * The address and preset this process resolves its brand from. The admin's
 * build writes its own into every bundle as NEXT_PUBLIC_BRAND_BASE_URL and
 * NEXT_PUBLIC_BRAND_PRESET, so the browser, the prerendered pages and the
 * server all show the same brand. Everywhere else, such as the worker, reads
 * APP_BASE_URL and BRAND_PRESET at start.
 */
export function brandInput(): { appBaseUrl: string | undefined; preset: string | undefined } {
  // Named in full so Next.js can write the build's values in place.
  const builtBaseUrl = process.env.NEXT_PUBLIC_BRAND_BASE_URL;
  const builtPreset = process.env.NEXT_PUBLIC_BRAND_PRESET;
  if (builtBaseUrl !== undefined || builtPreset !== undefined) return { appBaseUrl: builtBaseUrl, preset: builtPreset };
  return { appBaseUrl: process.env.APP_BASE_URL, preset: process.env.BRAND_PRESET };
}

let current: ResolvedBrand | undefined;

/** This deployment's brand, resolved once per process. */
export function currentBrand(): ResolvedBrand {
  current ??= Object.freeze(resolveBrand(brandInput()));
  return current;
}

/**
 * What a deployment should hear about its brand at start: a preset the
 * domain overrides, a preset that names no brand, an address no brand
 * claims, or no address to read a brand from. `error` is set when
 * BRAND_REQUIRED=true and no brand file matched, and the process should
 * refuse to start.
 */
export function brandStartupReport(brand: ResolvedBrand, environment: Record<string, string | undefined> = process.env): { info: string; warnings: string[]; error: string | null } {
  const warnings: string[] = [];
  if (brand.ignoredPreset) warnings.push(`[brand] brand.preset_ignored: BRAND_PRESET=${brand.ignoredPreset} has no effect, because ${brand.domain} belongs to the ${brand.id} brand.`);
  if (brand.unknownPreset) warnings.push(`[brand] brand.preset_unknown: BRAND_PRESET=${brand.unknownPreset} names no folder under brands/, so the ${brand.id} brand stands in.`);
  if (brand.source === "default" && environment.NODE_ENV === "production") {
    warnings.push(brand.host
      ? `[brand] brand.unmatched: no brand in brands/index.json claims ${brand.host}, so the default ${brand.id} brand stands in.`
      : `[brand] brand.base_url_missing: APP_BASE_URL is missing or isn't a URL, so the default ${brand.id} brand stands in. Set it to the dashboard's address, such as https://app.example.com.`);
  }
  const required = environment.BRAND_REQUIRED === "true" && !brandFileMatched(brand);
  return {
    info: `[brand] ${brand.id} (${brand.source}${brand.domain ? ` ${brand.domain}` : ""}), shown as ${brand.appName}`,
    warnings,
    error: required ? `[brand] BRAND_REQUIRED=true, but no brand file matches ${brand.host ?? "APP_BASE_URL"} or BRAND_PRESET.` : null,
  };
}
