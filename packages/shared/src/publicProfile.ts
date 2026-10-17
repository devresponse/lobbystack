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

// Control and format characters, and line or paragraph separators, would let
// text on a public page hide or rearrange what's around it.
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_CHARACTERS_EXCEPT_NEWLINE = /(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

// Each field cleans up its text before checking it, and keeps an empty value
// as null. They stay plain strings to zod, so the API documents them as text.

/** One line of text: whitespace runs become one space; empty becomes null. */
function singleLine(max: number) {
  return z.string()
    .overwrite((value) => value.replace(/\s+/g, " ").trim())
    .max(max)
    .refine((value) => !UNSAFE_CHARACTERS.test(value), "Use plain text.")
    .nullable()
    .transform((value) => value || null);
}

/** Plain text that keeps its paragraphs, with at most one blank line between them. */
const description = z.string()
  .overwrite((value) => value.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim())
  .max(PUBLIC_PROFILE_LIMITS.description)
  .refine((value) => !UNSAFE_CHARACTERS_EXCEPT_NEWLINE.test(value), "Use plain text.")
  .nullable()
  .transform((value) => value || null);

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
