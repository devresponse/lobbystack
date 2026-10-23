import type { ResolvedBillingDiscount } from "./billingProfile";
import type { BillingInterval, BillingPlanOffer, HostedCheckoutPlanSlug } from "./billing";

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
  /** What it includes each month: its own allowances, with its tier's for any billing.json leaves out. */
  included: BillingPlanOffer["included"];
  /** The allowances it includes more of than its tier. */
  moreThanTier: Array<keyof BillingPlanOffer["included"]>;
};

/** The allowances a plan includes more of than its tier; no limit is more than any. */
export function allowancesAboveTier(included: BillingPlanOffer["included"], tier: BillingPlanOffer["included"]): Array<keyof BillingPlanOffer["included"]> {
  return (Object.keys(included) as Array<keyof BillingPlanOffer["included"]>).filter((key) => {
    const own = included[key];
    const base = tier[key];
    return base !== null && (own === null || own > base);
  });
}

/** The promo plan a business is on, for Settings > Plan: its name, discount, prices and when it ends. */
export type BillingPromoPlanView = {
  plan: string;
  tier: HostedCheckoutPlanSlug;
  names: Record<string, string>;
  discount: ResolvedBillingDiscount | null;
  /** Its prices' currency; null when it has none. */
  currency: string | null;
  /** When it ends, ISO 8601: the renewal that ends it once that is the current period's end, else the date its months run out. Null for a plan with no end. */
  ends: string | null;
  /** What happens when it ends: the subscription moves to the tier, or it ends. Null for a plan with no end. */
  endsWith: PromoPlanEnding | null;
  prices: Array<{ interval: BillingInterval; cents: number; perMonth: number }>;
};

/** What ends a time-limited plan: a move to its tier's standard plan, or the end of the subscription. */
export type PromoPlanEnding = "tier" | "cancel";

/**
 * The renewal that ends a time-limited plan: the current period's end once it
 * reaches the plan's end, give or take three days. Polar adds each month to
 * the last renewal, so a cycle started on the 31st can renew on the 28th from
 * February on, while the account counts the months from the start; a period
 * is never shorter than 28 days, so no earlier renewal comes that close. Null
 * when a later renewal does, at the plan's price until then. Without a
 * period, the plan's end itself.
 */
export function promoPlanEndRenewal(planEnds: Date, currentPeriodEnd: Date | null): Date | null {
  if (!currentPeriodEnd) return planEnds;
  return currentPeriodEnd.getTime() >= planEnds.getTime() - 3 * 24 * 60 * 60_000 ? currentPeriodEnd : null;
}

/** How a business's promo plan ends: as an operator chose, else as the plan says. A plan that keeps going (keep) has none. */
export function promoPlanEnding(chosen: string | null | undefined, planEnds: string | null | undefined): PromoPlanEnding | null {
  for (const value of [chosen, planEnds]) {
    if (value === "tier" || value === "cancel") return value;
  }
  return null;
}

/** A plan's name in the language asked for, else in English, else in any language it has. */
export function billingPlanName(names: Record<string, string>, language: string): string | null {
  return names[language.split("-")[0] ?? language] ?? names.en ?? Object.values(names)[0] ?? null;
}
