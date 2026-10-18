import { z } from "zod";

import { normalizeEmailAddress } from "./brandLinks";

// A business's public profile page at /profile/<slug>: what owners and admins
// set for it in Settings, which the dashboard and the API share.

/** Where profile pages live on the deployment's own domain. */
export const PUBLIC_PROFILE_PATH_PREFIX = "/profile/";

/** The page's path for a business slug. */
export function publicProfilePath(slug: string): string {
  return `${PUBLIC_PROFILE_PATH_PREFIX}${encodeURIComponent(slug)}`;
}

export const PUBLIC_PROFILE_LIMITS = {
  category: 80,
  description: 750,
  addressLine: 200,
  city: 120,
  region: 120,
  postalCode: 20,
  email: 254,
} as const;

// Characters that would let text on a public page hide or rearrange what's
// around it: control characters, line and paragraph separators, bidirectional
// controls, interlinear annotations and the deprecated format characters.
// Other format characters are fine, such as the joiners inside emoji and the
// words of many scripts.
const UNSAFE = String.raw`\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u206F\uFFF9-\uFFFB`;
// Tag characters are invisible, so they're only fine where they spell an emoji
// flag, such as Scotland's: after a black flag and up to the cancel tag.
const TAG_FLAG = String.raw`\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}`;
const TAG = String.raw`[\u{E0000}-\u{E007F}]`;
const UNSAFE_TEXT = new RegExp(`${TAG_FLAG}|${TAG}|[${UNSAFE}]`, "gu");
const UNSAFE_TEXT_EXCEPT_NEWLINE = new RegExp(`${TAG_FLAG}|${TAG}|(?!\\n)[${UNSAFE}]`, "gu");

const isTagFlag = (match: string) => match.startsWith("\u{1F3F4}");

function isPlainText(value: string, pattern: RegExp): boolean {
  return [...value.matchAll(pattern)].every(([match]) => isTagFlag(match));
}

// Invisible characters pasted text often brings along: soft hyphens, zero-width
// spaces, word joiners, invisible math operators and byte order marks. They're
// taken out rather than refused.
const INVISIBLE = /[\u00AD\u200B\u2060-\u2064\uFEFF]/g;

// Each field cleans up its text before checking it, and keeps an empty value
// as null. They stay plain strings to zod, so the API documents them as text.

/** One line of text: whitespace runs become one space; empty becomes null. */
function singleLine(max: number) {
  return z.string()
    .overwrite((value) => value.replace(INVISIBLE, "").replace(/\s+/g, " ").trim())
    .max(max)
    .refine((value) => isPlainText(value, UNSAFE_TEXT), "Use plain text.")
    .nullable()
    .transform((value) => value || null);
}

function tidyDescription(value: string): string {
  return value.replace(INVISIBLE, "").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Plain text that keeps its paragraphs, with at most one blank line between them. */
const description = z.string()
  .overwrite(tidyDescription)
  .max(PUBLIC_PROFILE_LIMITS.description)
  .refine((value) => isPlainText(value, UNSAFE_TEXT_EXCEPT_NEWLINE), "Use plain text.")
  .nullable()
  .transform((value) => value || null);

/**
 * Text no one typed into the profile, such as the receptionist's summary, as a
 * description: what the description field refuses is taken out instead, and it
 * is cut to the field's length. Empty becomes null.
 */
export function publicProfileDescriptionFrom(text: string): string | null {
  const cleaned = tidyDescription(text.replace(UNSAFE_TEXT_EXCEPT_NEWLINE, (match) => (isTagFlag(match) ? match : ""))).slice(0, PUBLIC_PROFILE_LIMITS.description).trim();
  return cleaned || null;
}

const countryCode = z.string()
  .overwrite((value) => value.trim().toUpperCase())
  .regex(/^(?:[A-Z]{2})?$/, "Use a two-letter country code, such as CA.")
  .nullable()
  .transform((value) => value || null);

const publicEmail = z.string()
  .overwrite((value) => value.trim())
  .max(PUBLIC_PROFILE_LIMITS.email)
  .refine((value) => !value || normalizeEmailAddress(value) !== null, "Enter an email address such as hello@example.com.")
  .nullable()
  .transform((value) => value || null);

/** The page's text fields, checked the same way by the dashboard and the API. */
export const publicProfileTextFields = {
  category: singleLine(PUBLIC_PROFILE_LIMITS.category),
  description,
  publicEmail,
  address: {
    line1: singleLine(PUBLIC_PROFILE_LIMITS.addressLine),
    line2: singleLine(PUBLIC_PROFILE_LIMITS.addressLine),
    city: singleLine(PUBLIC_PROFILE_LIMITS.city),
    region: singleLine(PUBLIC_PROFILE_LIMITS.region),
    postalCode: singleLine(PUBLIC_PROFILE_LIMITS.postalCode),
    countryCode,
  },
} as const;

/** A text field that reads a missing value as empty. */
function orEmpty<T extends z.ZodType>(field: T) {
  return z.preprocess((value) => value ?? null, field);
}

const { address: addressFields } = publicProfileTextFields;

export const publicProfileAddressSchema = z.object({
  line1: orEmpty(addressFields.line1),
  line2: orEmpty(addressFields.line2),
  city: orEmpty(addressFields.city),
  region: orEmpty(addressFields.region),
  postalCode: orEmpty(addressFields.postalCode),
  countryCode: orEmpty(addressFields.countryCode),
}).strict();

/** Everything an owner or admin sets for the page. The dashboard sends all of it on each save. */
export const publicProfileSettingsSchema = z.object({
  published: z.boolean(),
  category: orEmpty(publicProfileTextFields.category),
  description: orEmpty(publicProfileTextFields.description),
  address: publicProfileAddressSchema,
  publicEmail: orEmpty(publicProfileTextFields.publicEmail),
  showPhone: z.boolean(),
  showHours: z.boolean(),
  showServices: z.boolean(),
  showMap: z.boolean(),
  widgetKeyId: z.uuid().nullable(),
}).strict();

export type PublicProfileAddress = z.output<typeof publicProfileAddressSchema>;
export type PublicProfileSettings = z.output<typeof publicProfileSettingsSchema>;

/** The address on one line, or as a maps search: the parts that are set, in order. */
export function formatPublicProfileAddress(address: PublicProfileAddress, separator = ", "): string {
  const locality = [address.city, [address.region, address.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [address.line1, address.line2, locality, address.countryCode].filter(Boolean).join(separator);
}

/** Whether there's enough of an address to show on a map: a street or a city. */
export function hasMappableAddress(address: PublicProfileAddress): boolean {
  return Boolean(address.line1 || address.city);
}
