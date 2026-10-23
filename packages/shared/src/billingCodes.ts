import type { ResolvedBillingDiscount } from "./billingProfile";
import type { BillingInterval, HostedCheckoutPlanSlug } from "./billing";

// Promo codes, as operators issue them and businesses type them. A code is
// stored in upper case and compared regardless of case and spaces, so
// "allo-7k2q px9m" finds ALLO-7K2Q-PX9M.

export const BILLING_CODE_MIN_LENGTH = 4;
export const BILLING_CODE_MAX_LENGTH = 32;

/** Letters and digits in groups joined by single hyphens. Each hyphen ends a group, so a match never backtracks. */
const BILLING_CODE_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

/** Generated codes leave out letters and digits people mix up: 0 and O, 1, I and L. */
export const BILLING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A code as stored: upper case, with spaces and surrounding whitespace removed. */
export function normalizeBillingCode(value: string): string {
  return value.slice(0, BILLING_CODE_MAX_LENGTH * 2).replace(/\s/g, "").toUpperCase();
}

/** Whether a normalized value can be a code at all, so a lookup never runs for one that can't. */
export function isBillingCode(value: string): boolean {
  return value.length >= BILLING_CODE_MIN_LENGTH && value.length <= BILLING_CODE_MAX_LENGTH && BILLING_CODE_PATTERN.test(value);
}

/** The prefix of a generated code: the first four letters or digits of the brand's name, such as ALLO for AlloPlace. */
export function billingCodePrefix(brandName: string): string {
  const letters = brandName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  return letters.length >= 2 ? letters : "PROMO";
}

/** What one period costs once a plan's discount applies, or the price itself without one. */
export function discountedCents(cents: number, discount: Pick<ResolvedBillingDiscount, "type" | "basis_points" | "amount_cents"> | null): number {
  if (!discount) return cents;
  if (discount.type === "percentage") return Math.max(0, Math.round(cents * (1 - (discount.basis_points ?? 0) / 10_000)));
  return Math.max(0, cents - (discount.amount_cents ?? 0));
}

/** What the dashboard shows for a code a business entered: the plan it unlocks, the discount, and each price before and after it. */
export type BillingCodeView = {
  /** The code as stored. */
  code: string;
  plan: string;
  /** The standard plan whose features and limits it has. */
  tier: HostedCheckoutPlanSlug;
  /** Its name in each language billing.json gives. */
  names: Record<string, string>;
  discount: ResolvedBillingDiscount | null;
  currency: string;
  /** The business already pays for this plan. */
  current: boolean;
  prices: Array<{ interval: BillingInterval; cents: number; discountedCents: number; checkoutAvailable: boolean }>;
};

/** The promo plan a business is on, for Settings > Plan: its name, discount, prices and when it ends. */
export type BillingPromoPlanView = {
  plan: string;
  tier: HostedCheckoutPlanSlug;
  names: Record<string, string>;
  discount: ResolvedBillingDiscount | null;
  /** Its prices' currency; null when it has none. */
  currency: string | null;
  /** ISO 8601, or null for a plan with no end. */
  ends: string | null;
  prices: Array<{ interval: BillingInterval; cents: number; perMonth: number }>;
};

/** A plan's name in the language asked for, else in English, else in any language it has. */
export function billingPlanName(names: Record<string, string>, language: string): string | null {
  return names[language.split("-")[0] ?? language] ?? names.en ?? Object.values(names)[0] ?? null;
}
