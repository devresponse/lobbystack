import { z } from "zod";

import type { BillingInterval } from "./billing";
import type { InterfaceLocale } from "./locales";

// brands/<brand>/billing.json: every plan a brand sells, standard or not, and
// how each becomes a row of billing_plans and its billing_prices. `pnpm
// brands:build` checks each brand's file with billingProfileSchema, and the
// catalog apply checks the file it is sent with it again. The four standard
// plans are the keys free_cloud, starter, pro and enterprise; any other key is
// an additional plan that names the tier it behaves like. No Node imports, so
// the browser bundle can import the package: whoever hashes uses node:crypto.

export const BILLING_PROFILE_VERSION = 1;

/** The built-in tiers the code knows. The standard plans are the plans whose code is their tier. */
export const billingPlanTiers = ["free_cloud", "starter", "pro", "enterprise"] as const;
export type BillingPlanTier = (typeof billingPlanTiers)[number];

/** Who can get a plan: anyone, only with a promo code, or only when an operator assigns it. */
export const billingPlanAccessLevels = ["public", "code", "hidden"] as const;
export type BillingPlanAccess = (typeof billingPlanAccessLevels)[number];

/** What happens when a time-limited plan's months run out. */
export const billingPlanEndings = ["tier", "keep", "cancel"] as const;
export type BillingPlanEnding = (typeof billingPlanEndings)[number];

/** A plan's code: its permanent key in billing.json and billing_plans. */
export const PLAN_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,46}[a-z0-9]$/;
/** Plans a file may hold besides the four standard ones. */
export const MAX_ADDITIONAL_PLANS = 50;

const BYTES_PER_MB = 1_048_576;
const STANDARD_SORT: Record<BillingPlanTier, number> = { free_cloud: 10, starter: 20, pro: 30, enterprise: 40 };
const ADDITIONAL_SORT = 100;

const count = (max: number) => z.number().int().min(0).max(max);
const cents = (max: number) => z.number().int().min(1).max(max);
const months = z.number().int().min(1).max(36);
const proration = z.enum(["invoice", "prorate", "next_period", "reset"]);

const prices = z.strictObject({ monthlyCents: cents(10_000_000).optional(), annualCents: cents(120_000_000).optional() });
const included = z.strictObject({ voiceMinutes: count(100_000), alertSmsSegments: count(100_000), outboundCallAttempts: count(100_000), chatAiUnits: count(1_000_000) });
// A business holds one number at most, so a plan includes none or one.
const limits = z.strictObject({ knowledgeStorageMb: count(1_024), businessNumbers: count(1) });
const overageCents = z.strictObject({ voiceMinute: count(1_000), alertSmsSegment: count(1_000), outboundCallAttempt: count(1_000) });

const freePlan = z.strictObject({ sold: z.literal(false), included, limits });
const tierPlan = z.discriminatedUnion("sold", [
  z.strictObject({ sold: z.literal(true), prices, included, limits, overageCents }),
  z.strictObject({ sold: z.literal(false), included, limits, overageCents }),
]);
const customPlan = z.strictObject({ sold: z.literal(false), custom: z.literal(true) });

const name = z.string().trim().min(1).max(60);
const duration = z.enum(["once", "forever", "repeating"]);
const discount = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("percentage"), basisPoints: z.number().int().min(1).max(10_000), duration, durationInMonths: months.optional() }),
  z.strictObject({ type: z.literal("fixed"), amountCents: cents(10_000_000), duration, durationInMonths: months.optional() }),
]);
const additionalPlan = z.strictObject({
  tier: z.enum(["starter", "pro"]),
  access: z.enum(billingPlanAccessLevels),
  names: z.strictObject({ en: name, fr: name, es: name, sr: name } satisfies Record<InterfaceLocale, typeof name>),
  sold: z.literal(true),
  prices,
  included: included.partial().optional(),
  limits: limits.partial().optional(),
  overageCents: overageCents.partial().optional(),
  months: months.optional(),
  endsWith: z.enum(billingPlanEndings).optional(),
  offerEndsAt: z.iso.datetime({ offset: true }).optional(),
  discount: discount.optional(),
});

const billingProfileShape = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(BILLING_PROFILE_VERSION),
  currency: z.string().regex(/^[a-z]{3}$/, "three lowercase letters, such as cad"),
  polar: z.strictObject({ allowMultipleSubscriptions: z.boolean(), portalPlanChanges: z.boolean(), upgradeProration: proration, downgradeProration: proration }),
  // catchall makes every key but the four standard ones an additional plan.
  plans: z.object({ free_cloud: freePlan, starter: tierPlan, pro: tierPlan, enterprise: customPlan }).catchall(additionalPlan),
});

type ProfileShape = z.output<typeof billingProfileShape>;
type PlanPrices = z.output<typeof prices>;
type AdditionalPlan = z.output<typeof additionalPlan>;
type StandardPlans = Pick<ProfileShape["plans"], BillingPlanTier>;

const priceFields = { monthlyCents: "monthly", annualCents: "annual" } as const satisfies Record<keyof PlanPrices, BillingInterval>;

function isStandardCode(code: string): code is BillingPlanTier {
  return (billingPlanTiers as readonly string[]).includes(code);
}

/** The plans other than the four standard ones, by code. */
function additionalPlans(profile: Pick<ProfileShape, "plans">): Array<[string, AdditionalPlan]> {
  return Object.entries(profile.plans).filter(([code]) => !isStandardCode(code)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) as Array<[string, AdditionalPlan]>;
}

function planPrices(plan: unknown): PlanPrices | undefined {
  return plan && typeof plan === "object" && "prices" in plan ? (plan as { prices: PlanPrices }).prices : undefined;
}

/**
 * The checks that need more than one field (C1 to C7 of the design), which the
 * JSON Schema can't carry. Each issue's path names the field to fix.
 */
export function checkBillingProfile(profile: ProfileShape, context: z.RefinementCtx): void {
  const issue = (path: Array<string>, message: string) => context.addIssue({ code: "custom", path: ["plans", ...path], message });
  for (const [code, plan] of Object.entries(profile.plans)) {
    // C3: the code is permanent and becomes the row's key.
    if (!PLAN_CODE_PATTERN.test(code)) issue([code], "a plan code is 3 to 48 lowercase letters, digits, _ and -, starting and ending with a letter or digit");
    const own = planPrices(plan);
    if (!own) continue;
    // C1: a year never costs more than twelve months.
    if (own.monthlyCents !== undefined && own.annualCents !== undefined && own.annualCents > own.monthlyCents * 12) issue([code, "prices", "annualCents"], `the annual price is more than 12 monthly prices (${own.monthlyCents * 12})`);
    // C2: Polar can only sell a plan that has a price.
    if (own.monthlyCents === undefined && own.annualCents === undefined) issue([code, "prices"], "a sold plan needs monthlyCents, annualCents or both");
  }
  const extras = additionalPlans(profile);
  extras.slice(MAX_ADDITIONAL_PLANS).forEach(([code]) => issue([code], `a file holds at most ${MAX_ADDITIONAL_PLANS} plans besides the four standard ones`));
  for (const [code, plan] of extras) {
    // C4: an additional plan is sold the way its tier is.
    const tier = profile.plans[plan.tier];
    if (!tier.sold) issue([code, "tier"], `${plan.tier} isn't sold in this file, so no plan can be based on it`);
    else {
      for (const field of Object.keys(priceFields) as Array<keyof PlanPrices>) {
        if (plan.prices[field] !== undefined && tier.prices[field] === undefined) issue([code, "prices", field], `${plan.tier} has no ${priceFields[field]} price, so this plan can't have one`);
      }
    }
    // C5: a plan that ends says what happens next.
    if ((plan.months === undefined) !== (plan.endsWith === undefined)) issue([code, "endsWith"], "months and endsWith go together: set both or neither");
    if (plan.discount) {
      // C6: only a repeating discount lasts some months.
      if ((plan.discount.duration === "repeating") !== (plan.discount.durationInMonths !== undefined)) issue([code, "discount", "durationInMonths"], "durationInMonths is set exactly when duration is repeating");
      // C7: a fixed discount never takes a price below zero.
      const lowest = Math.min(...[plan.prices.monthlyCents, plan.prices.annualCents].filter((value): value is number => value !== undefined));
      if (plan.discount.type === "fixed" && Number.isFinite(lowest) && plan.discount.amountCents > lowest) issue([code, "discount", "amountCents"], `the discount is more than the plan's lowest price (${lowest})`);
    }
  }
}

export const billingProfileSchema = billingProfileShape.superRefine(checkBillingProfile);

/** A billing.json as checked. */
export type BillingProfile = z.output<typeof billingProfileSchema>;
/** A checked file without its $schema, every object's keys in order. */
export type NormalizedBillingProfile = Omit<BillingProfile, "$schema">;

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => [key, sortedKeys(entry)]));
}

/** JSON with every object's keys sorted and no spaces, so equal values always give equal text and hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedKeys(value));
}

/** The checked file without $schema, keys in order: what a run stores and the profile hash covers. */
export function normalizeBillingProfile(profile: BillingProfile): NormalizedBillingProfile {
  const { $schema: _editorHint, ...rest } = profile;
  return sortedKeys(rest) as NormalizedBillingProfile;
}

/** The text the profile hash is the SHA-256 of. Whitespace, key order and $schema never change it. */
export function canonicalBillingProfileJson(profile: BillingProfile): string {
  return canonicalJson(normalizeBillingProfile(profile));
}

/** A Polar discount as billing_plans.discount stores it, in snake case. */
export type ResolvedBillingDiscount = {
  type: "percentage" | "fixed";
  basis_points?: number;
  amount_cents?: number;
  duration: "once" | "forever" | "repeating";
  duration_in_months?: number;
};

export type ResolvedBillingPrice = { period: BillingInterval; currency: string; cents: number };

/** One plan as a complete billing_plans row and its prices, under the columns' own names. */
export type ResolvedBillingPlan = {
  code: string;
  tier: BillingPlanTier;
  access: BillingPlanAccess;
  sold: boolean;
  custom: boolean;
  overage: boolean;
  names: Record<InterfaceLocale, string> | null;
  voice_sec: number | null;
  sms_seg: number | null;
  calls_out: number | null;
  chat_units: number | null;
  kb_bytes: number | null;
  numbers: number | null;
  voice_rate: number | null;
  sms_rate: number | null;
  call_rate: number | null;
  months: number | null;
  ends: BillingPlanEnding | null;
  /** ISO 8601 in UTC, to the millisecond. */
  offer_end: string | null;
  discount: ResolvedBillingDiscount | null;
  sort: number;
  prices: ResolvedBillingPrice[];
};

type Allowances = Pick<ResolvedBillingPlan, "voice_sec" | "sms_seg" | "calls_out" | "chat_units" | "kb_bytes" | "numbers" | "voice_rate" | "sms_rate" | "call_rate">;

const noAllowances: Allowances = { voice_sec: null, sms_seg: null, calls_out: null, chat_units: null, kb_bytes: null, numbers: null, voice_rate: null, sms_rate: null, call_rate: null };

function standardAllowances(plan: StandardPlans[BillingPlanTier]): Allowances {
  if ("custom" in plan) return noAllowances;
  const rates = "overageCents" in plan ? plan.overageCents : undefined;
  return {
    voice_sec: plan.included.voiceMinutes * 60,
    sms_seg: plan.included.alertSmsSegments,
    calls_out: plan.included.outboundCallAttempts,
    chat_units: plan.included.chatAiUnits,
    kb_bytes: plan.limits.knowledgeStorageMb * BYTES_PER_MB,
    numbers: plan.limits.businessNumbers,
    voice_rate: rates?.voiceMinute ?? null,
    sms_rate: rates?.alertSmsSegment ?? null,
    call_rate: rates?.outboundCallAttempt ?? null,
  };
}

function resolvedPrices(own: PlanPrices | undefined, currency: string): ResolvedBillingPrice[] {
  if (!own) return [];
  return (Object.keys(priceFields) as Array<keyof PlanPrices>).flatMap((field) => (own[field] === undefined ? [] : [{ period: priceFields[field], currency, cents: own[field]! }])).sort((a, b) => (a.period < b.period ? -1 : 1));
}

function resolvedDiscount(value: AdditionalPlan["discount"]): ResolvedBillingDiscount | null {
  if (!value) return null;
  return {
    type: value.type,
    ...(value.type === "percentage" ? { basis_points: value.basisPoints } : { amount_cents: value.amountCents }),
    duration: value.duration,
    ...(value.durationInMonths !== undefined ? { duration_in_months: value.durationInMonths } : {}),
  };
}

/**
 * Every plan of a checked file as the complete row it becomes, by sort then
 * code. An additional plan's missing allowances, limits and rates are copied
 * from its tier's standard plan in the same file, so no reader ever merges two rows.
 */
export function resolveBillingPlans(profile: Pick<BillingProfile, "currency" | "plans">): ResolvedBillingPlan[] {
  const resolved: ResolvedBillingPlan[] = billingPlanTiers.map((tier) => {
    const plan = profile.plans[tier];
    return {
      code: tier,
      tier,
      access: tier === "enterprise" ? "hidden" : "public",
      sold: plan.sold,
      custom: "custom" in plan,
      overage: tier !== "free_cloud",
      names: null,
      ...standardAllowances(plan),
      months: null,
      ends: null,
      offer_end: null,
      discount: null,
      sort: STANDARD_SORT[tier],
      prices: resolvedPrices(planPrices(plan), profile.currency),
    };
  });
  for (const [code, plan] of additionalPlans(profile)) {
    const base = standardAllowances(profile.plans[plan.tier]);
    const minutes = plan.included?.voiceMinutes;
    const storage = plan.limits?.knowledgeStorageMb;
    resolved.push({
      code,
      tier: plan.tier,
      access: plan.access,
      sold: true,
      custom: false,
      overage: true,
      names: { en: plan.names.en, fr: plan.names.fr, es: plan.names.es, sr: plan.names.sr },
      voice_sec: minutes === undefined ? base.voice_sec : minutes * 60,
      sms_seg: plan.included?.alertSmsSegments ?? base.sms_seg,
      calls_out: plan.included?.outboundCallAttempts ?? base.calls_out,
      chat_units: plan.included?.chatAiUnits ?? base.chat_units,
      kb_bytes: storage === undefined ? base.kb_bytes : storage * BYTES_PER_MB,
      numbers: plan.limits?.businessNumbers ?? base.numbers,
      voice_rate: plan.overageCents?.voiceMinute ?? base.voice_rate,
      sms_rate: plan.overageCents?.alertSmsSegment ?? base.sms_rate,
      call_rate: plan.overageCents?.outboundCallAttempt ?? base.call_rate,
      months: plan.months ?? null,
      ends: plan.endsWith ?? null,
      offer_end: plan.offerEndsAt === undefined ? null : new Date(plan.offerEndsAt).toISOString(),
      discount: resolvedDiscount(plan.discount),
      sort: ADDITIONAL_SORT,
      prices: resolvedPrices(plan.prices, profile.currency),
    });
  }
  return resolved.sort((a, b) => a.sort - b.sort || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/** The plan columns its terms hash covers, besides prices and currency. */
export const billingPlanTermColumns = ["tier", "sold", "custom", "voice_sec", "sms_seg", "calls_out", "chat_units", "kb_bytes", "numbers", "voice_rate", "sms_rate", "call_rate", "months", "ends", "discount"] as const satisfies ReadonlyArray<keyof ResolvedBillingPlan>;

/**
 * The text a plan's terms hash is the SHA-256 of: what subscribers and Polar
 * depend on. It leaves out names, access, offer_end and sort, which may change
 * while people are on the plan.
 */
export function planTermsJson(plan: Pick<ResolvedBillingPlan, (typeof billingPlanTermColumns)[number] | "prices">): string {
  return canonicalJson({
    ...Object.fromEntries(billingPlanTermColumns.map((column) => [column, plan[column]])),
    currency: plan.prices[0]?.currency ?? null,
    prices: Object.fromEntries(plan.prices.map((price) => [price.period, price.cents])),
  });
}
