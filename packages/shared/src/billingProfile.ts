import { z } from "zod";

import { billingPlanCatalog, MAX_PACK_DAYS, type BillingInterval, type BillingProvider } from "./billing";
import { billingDisplaySchema, checkBillingDisplay } from "./billingDisplay";
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
/** Prepaid packs a file may hold: each size and length is a pack of its own. */
export const MAX_BILLING_PACKS = 30;
/** How many businesses one account may own when its brand's billing.json leaves accounts out: the limit from before the file could set one. */
export const DEFAULT_MAX_BUSINESSES_PER_ACCOUNT = 10;
/** The most businesses a billing.json may let one account own, since each business adds recurring worker jobs. */
export const MAX_BUSINESSES_PER_ACCOUNT_CEILING = 100;

const BYTES_PER_MB = 1_048_576;

/** The most receptionists a plan in billing.json may include; a custom plan gets the deployment's cap instead. */
export const MAX_PLAN_RECEPTIONISTS = 50;
/** Receptionists a standard plan includes when its billing.json leaves limits.receptionists out: the built-in plans' own. */
export const DEFAULT_PLAN_RECEPTIONISTS = {
  free_cloud: billingPlanCatalog.free_cloud.includedReceptionists,
  starter: billingPlanCatalog.starter.includedReceptionists,
  pro: billingPlanCatalog.pro.includedReceptionists,
} as const satisfies Record<Exclude<BillingPlanTier, "enterprise">, number>;
const STANDARD_SORT: Record<BillingPlanTier, number> = { free_cloud: 10, starter: 20, pro: 30, enterprise: 40 };
const ADDITIONAL_SORT = 100;

const count = (max: number) => z.number().int().min(0).max(max);
const cents = (max: number) => z.number().int().min(1).max(max);
const months = z.number().int().min(1).max(36);
const proration = z.enum(["invoice", "prorate", "next_period", "reset"]);

const prices = z.strictObject({ monthlyCents: cents(10_000_000).optional(), annualCents: cents(120_000_000).optional() });
const included = z.strictObject({ voiceMinutes: count(100_000), alertSmsSegments: count(100_000), outboundCallAttempts: count(100_000), chatAiUnits: count(1_000_000) });
// A business holds one number at most, so a plan includes none or one.
// Receptionists active at once; a file that leaves it out gets its tier's
// default (DEFAULT_PLAN_RECEPTIONISTS), so files written before receptionists still apply.
const limits = z.strictObject({ knowledgeStorageMb: count(1_024), businessNumbers: count(1), receptionists: z.number().int().min(1).max(MAX_PLAN_RECEPTIONISTS).optional() });
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
// A prepaid pack (docs/features/prepaid-packs.md): voice minutes paid for
// once, used within days of the payment, or at any time when days is left
// out. Its monthly allowances and limits are the ones a business on it gets;
// whatever it leaves out comes from the file's Starter. Each size and length
// is a pack of its own, with its own price.
const packIncluded = z.strictObject({ alertSmsSegments: count(100_000), outboundCallAttempts: count(100_000), chatAiUnits: count(1_000_000) });
const pack = z.strictObject({
  names: z.strictObject({ en: name, fr: name, es: name, sr: name } satisfies Record<InterfaceLocale, typeof name>),
  minutes: z.number().int().min(1).max(100_000),
  days: z.number().int().min(1).max(MAX_PACK_DAYS).optional(),
  priceCents: cents(10_000_000),
  included: packIncluded.partial().optional(),
  limits: limits.partial().optional(),
});

// Rules for each account rather than each business. maxBusinesses: how many
// businesses one account may own, whether it creates them or claims them, 10
// when left out. maxBusinessesByPlan: that number for each plan, by plan code,
// or prepaid for a business with a live pack; an account may own as many as
// the best plan among its businesses allows, and a plan the map leaves out
// allows maxBusinesses (an additional plan, its tier's number first).
const businessCap = z.number().int().min(1).max(MAX_BUSINESSES_PER_ACCOUNT_CEILING);
const accounts = z.strictObject({ maxBusinesses: businessCap.optional(), maxBusinessesByPlan: z.record(z.string(), businessCap).optional() });

/** A billing.json's accounts section: rules for each account, which the admin enforces from its build. */
export type BillingAccounts = z.output<typeof accounts>;

/** The key of accounts.maxBusinessesByPlan for a business on a live prepaid pack, which has no plan code. */
export const PREPAID_BUSINESS_CAP_KEY = "prepaid";

/** A business's plan as its account's business cap reads it: its tier (BillingPlanSlug), and its additional plan's code while that plan is live. */
export type BusinessCapPlan = { plan: string; planCode?: string | null };

// The tiers a business can move to, whose caps say whether a higher plan allows more.
const CAP_TIERS = ["free_cloud", "starter", "pro", "enterprise", PREPAID_BUSINESS_CAP_KEY] as const;

/**
 * How many businesses an account may own because one of its businesses is on
 * this plan: accounts.maxBusinessesByPlan for its additional plan's code, then
 * for its tier, then accounts.maxBusinesses, then 10. A self-hosted business's
 * tier is self_host, which the map can't name, so maxBusinesses decides.
 */
export function planBusinessCap(accounts: BillingAccounts | undefined, plan: BusinessCapPlan): number {
  const byPlan = accounts?.maxBusinessesByPlan ?? {};
  const own = (code: string | null | undefined) => (code && Object.hasOwn(byPlan, code) ? byPlan[code] : undefined);
  return own(plan.planCode) ?? own(plan.plan) ?? accounts?.maxBusinesses ?? DEFAULT_MAX_BUSINESSES_PER_ACCOUNT;
}

/**
 * The most businesses an account may own while it owns, or is about to own,
 * businesses on these plans: the cap of the best of them. With none,
 * accounts.maxBusinesses, or 10.
 */
export function accountBusinessCap(accounts: BillingAccounts | undefined, plans: readonly BusinessCapPlan[]): number {
  if (plans.length === 0) return accounts?.maxBusinesses ?? DEFAULT_MAX_BUSINESSES_PER_ACCOUNT;
  return Math.max(...plans.map((plan) => planBusinessCap(accounts, plan)));
}

/** The most businesses any plan lets an account own: the cap of the best tier or plan code the section names. */
export function highestBusinessCap(accounts: BillingAccounts | undefined): number {
  return Math.max(...CAP_TIERS.map((plan) => planBusinessCap(accounts, { plan })), ...Object.values(accounts?.maxBusinessesByPlan ?? {}));
}

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

// A deployment sells through the block of its billing provider (ADR 0010):
// a file holds the block of each provider its brand's deployments use, and
// an apply refuses a file without its deployment's (provider_block_missing).
const polarBlock = z.strictObject({ allowMultipleSubscriptions: z.boolean(), portalPlanChanges: z.boolean(), upgradeProration: proration, downgradeProration: proration });

/** A Stripe product tax code, such as txcd_10103001 (software as a service for business use). */
export const STRIPE_TAX_CODE_PATTERN = /^txcd_\d{8}$/;

const stripeBlock = z.strictObject({
  // How a plan change charges, in Polar's words, as the Polar adapter maps them.
  upgrade: z.enum(["invoice", "prorate", "reset"]),
  downgrade: z.enum(["next_period", "invoice", "prorate"]),
  // Whether Stripe's billing portal may switch between the standard plans, and cancel; Settings > Plan does both either way.
  portalPlanChanges: z.boolean(),
  portalCancel: z.boolean(),
  // Prices before tax, and the product tax code Stripe Tax computes with.
  tax: z.strictObject({ behavior: z.literal("exclusive"), code: z.string().regex(STRIPE_TAX_CODE_PATTERN, "a Stripe product tax code, such as txcd_10103001") }),
  // Hours Stripe waits after a month before finalizing its metered invoice: a Dashboard rule the API can't read.
  usageGraceHours: z.number().int().min(1).max(72),
  // separate: overage on a second, monthly subscription. checkout: its prices on the plan's own checkout, as Managed Payments needs.
  overage: z.enum(["separate", "checkout"]),
  // Stripe as the merchant of record (Managed Payments), instead of the operator with Stripe Tax.
  managedPayments: z.boolean(),
});

const billingProfileShape = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(BILLING_PROFILE_VERSION),
  currency: z.string().regex(/^[a-z]{3}$/, "three lowercase letters, such as cad"),
  polar: polarBlock.optional(),
  stripe: stripeBlock.optional(),
  // catchall makes every key but the four standard ones an additional plan.
  plans: z.object({ free_cloud: freePlan, starter: tierPlan, pro: tierPlan, enterprise: customPlan }).catchall(additionalPlan),
  // Prepaid packs by code; a file without the key sells none.
  packs: z.record(z.string(), pack).optional(),
  // Rules for each account, such as how many businesses one may own. The
  // admin enforces them from its build, so like display, the hash, the apply
  // and the stored profile leave them out: a change needs a deploy, not an apply.
  accounts: accounts.optional(),
  // The plan screens' words and layout (billingDisplay.ts). It sells nothing:
  // the hash, the apply and the stored profile leave it out.
  display: billingDisplaySchema.optional(),
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
 * The checks that need more than one field (C1 to C7 of the design, and C8 of
 * the Stripe plan), which the JSON Schema can't carry. Each issue's path
 * names the field to fix.
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
  const packs = Object.keys(profile.packs ?? {}).sort();
  for (const code of packs) {
    const packIssue = (path: Array<string>, message: string) => context.addIssue({ code: "custom", path: ["packs", code, ...path], message });
    // C10: a pack's code is permanent too, and no plan has it.
    if (!PLAN_CODE_PATTERN.test(code)) packIssue([], "a pack code is 3 to 48 lowercase letters, digits, _ and -, starting and ending with a letter or digit");
    if (Object.hasOwn(profile.plans, code)) packIssue([], "a plan already has this code");
  }
  packs.slice(MAX_BILLING_PACKS).forEach((code) => context.addIssue({ code: "custom", path: ["packs", code], message: `a file holds at most ${MAX_BILLING_PACKS} packs` }));
  // C11: the display section's cards, rows and {{names}}.
  if (profile.display) checkBillingDisplay(profile.display, { starter: profile.plans.starter.sold, pro: profile.plans.pro.sold }, (path, message) => context.addIssue({ code: "custom", path: ["display", ...path], message }));
  // C12: a cap per plan names a plan of this file, or prepaid for a business with a live pack.
  for (const code of Object.keys(profile.accounts?.maxBusinessesByPlan ?? {}).sort()) {
    if (code !== PREPAID_BUSINESS_CAP_KEY && !Object.hasOwn(profile.plans, code)) context.addIssue({ code: "custom", path: ["accounts", "maxBusinessesByPlan", code], message: `not a plan in this file: use a code under plans, or ${PREPAID_BUSINESS_CAP_KEY} for a business with a live pack` });
  }
  if (profile.stripe) {
    // C8: Managed Payments sells through Checkout alone, so overage can't be a subscription of its own.
    if (profile.stripe.managedPayments && profile.stripe.overage !== "checkout") context.addIssue({ code: "custom", path: ["stripe", "overage"], message: "with managedPayments, overage is checkout: Managed Payments sells only through Checkout" });
  }
}

export const billingProfileSchema = billingProfileShape.superRefine(checkBillingProfile);

/**
 * The file as a deployment on the provider sells it. With stripe.overage
 * checkout, overage is invoiced with the plan each month, so a Stripe
 * deployment leaves out every yearly price, as merchant of record needs, and
 * doesn't sell a plan that has only a yearly one (C9 of the Stripe plan). The
 * brand's Polar deployments sell the file as it is. What it returns is cast to
 * the file's type, so billingProfile.test.ts checks it still passes the schema.
 */
export function billingProfileForProvider<T extends Pick<z.output<typeof billingProfileShape>, "stripe" | "plans">>(profile: T, provider: BillingProvider): T {
  if (provider !== "stripe" || profile.stripe?.overage !== "checkout") return profile;
  const plans = Object.fromEntries(Object.entries(profile.plans).flatMap(([code, plan]): Array<[string, unknown]> => {
    const own = planPrices(plan);
    if (own?.annualCents === undefined) return [[code, plan]];
    const { annualCents: _yearly, ...monthly } = own;
    if (monthly.monthlyCents !== undefined) return [[code, { ...(plan as object), prices: monthly }]];
    // Only a yearly price: an additional plan isn't offered here, and a standard one isn't sold.
    if (!isStandardCode(code)) return [];
    const { prices: _prices, ...unsold } = plan as Record<string, unknown>;
    return [[code, { ...unsold, sold: false }]];
  }));
  return { ...profile, plans } as T;
}

/** A billing.json as checked. */
export type BillingProfile = z.output<typeof billingProfileSchema>;
/** A checked file without its $schema and the sections only its build carries (accounts, display), every object's keys in order. */
export type NormalizedBillingProfile = Omit<BillingProfile, "$schema" | "accounts" | "display">;

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => [key, sortedKeys(entry)]));
}

/** JSON with every object's keys sorted and no spaces, so equal values always give equal text and hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedKeys(value));
}

/**
 * The file as the billing commands send it to a deployment: without its
 * accounts and display sections, which sell nothing and reach the app
 * through its build alone, so a deployment built before either section
 * existed takes the file too.
 */
export function billingProfileForCatalog<T extends { accounts?: unknown; display?: unknown }>(profile: T): Omit<T, "accounts" | "display"> {
  const { accounts: _accounts, display: _screens, ...rest } = profile;
  return rest;
}

/**
 * The checked file without $schema, accounts and display, keys in order: what
 * a run stores and the profile hash covers. None of them sells anything, so
 * editing the plan screens' words or the business limit never changes the
 * hash, needs an apply or shows drift.
 */
export function normalizeBillingProfile(profile: BillingProfile): NormalizedBillingProfile {
  const { $schema: _editorHint, accounts: _accounts, display: _screens, ...rest } = profile;
  return sortedKeys(rest) as NormalizedBillingProfile;
}

/** The text the profile hash is the SHA-256 of. Whitespace, key order, $schema, accounts and display never change it. */
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
  /** Receptionists active at once; null on a custom plan, which gets the deployment's cap. Outside the terms hash. */
  receptionists: number | null;
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

type Allowances = Pick<ResolvedBillingPlan, "voice_sec" | "sms_seg" | "calls_out" | "chat_units" | "kb_bytes" | "numbers" | "receptionists" | "voice_rate" | "sms_rate" | "call_rate">;

const noAllowances: Allowances = { voice_sec: null, sms_seg: null, calls_out: null, chat_units: null, kb_bytes: null, numbers: null, receptionists: null, voice_rate: null, sms_rate: null, call_rate: null };

function standardAllowances(tier: BillingPlanTier, plan: StandardPlans[BillingPlanTier]): Allowances {
  if ("custom" in plan || tier === "enterprise") return noAllowances;
  const rates = "overageCents" in plan ? plan.overageCents : undefined;
  return {
    voice_sec: plan.included.voiceMinutes * 60,
    sms_seg: plan.included.alertSmsSegments,
    calls_out: plan.included.outboundCallAttempts,
    chat_units: plan.included.chatAiUnits,
    kb_bytes: plan.limits.knowledgeStorageMb * BYTES_PER_MB,
    numbers: plan.limits.businessNumbers,
    receptionists: plan.limits.receptionists ?? DEFAULT_PLAN_RECEPTIONISTS[tier],
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
      ...standardAllowances(tier, plan),
      months: null,
      ends: null,
      offer_end: null,
      discount: null,
      sort: STANDARD_SORT[tier],
      prices: resolvedPrices(planPrices(plan), profile.currency),
    };
  });
  for (const [code, plan] of additionalPlans(profile)) {
    const base = standardAllowances(plan.tier, profile.plans[plan.tier]);
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
      receptionists: plan.limits?.receptionists ?? base.receptionists,
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

/** One pack as a complete billing_pack_plans row and its price, under the columns' own names. */
export type ResolvedBillingPack = {
  code: string;
  names: Record<InterfaceLocale, string>;
  voice_sec: number;
  /** Null: the pack never ends. */
  days: number | null;
  sms_seg: number;
  calls_out: number;
  chat_units: number;
  kb_bytes: number;
  numbers: number;
  receptionists: number;
  sort: number;
  price: { currency: string; cents: number };
};

/**
 * Every pack of a checked file as the complete row it becomes, smallest and
 * shortest first. What a pack leaves out of its allowances and limits comes
 * from the file's Starter, so no reader ever merges two rows.
 */
export function resolveBillingPacks(profile: Pick<BillingProfile, "currency" | "plans" | "packs">): ResolvedBillingPack[] {
  const starter = standardAllowances("starter", profile.plans.starter);
  const packs = Object.entries(profile.packs ?? {}).map(([code, pack]): ResolvedBillingPack => {
    const storage = pack.limits?.knowledgeStorageMb;
    return {
      code,
      names: { en: pack.names.en, fr: pack.names.fr, es: pack.names.es, sr: pack.names.sr },
      voice_sec: pack.minutes * 60,
      days: pack.days ?? null,
      sms_seg: pack.included?.alertSmsSegments ?? starter.sms_seg ?? 0,
      calls_out: pack.included?.outboundCallAttempts ?? starter.calls_out ?? 0,
      chat_units: pack.included?.chatAiUnits ?? starter.chat_units ?? 0,
      kb_bytes: storage === undefined ? starter.kb_bytes ?? 0 : storage * BYTES_PER_MB,
      numbers: pack.limits?.businessNumbers ?? starter.numbers ?? 0,
      receptionists: pack.limits?.receptionists ?? starter.receptionists ?? DEFAULT_PLAN_RECEPTIONISTS.starter,
      sort: 0,
      price: { currency: profile.currency, cents: pack.priceCents },
    };
  });
  // A pack that never ends sorts after every length.
  const length = (pack: ResolvedBillingPack) => pack.days ?? Number.POSITIVE_INFINITY;
  packs.sort((a, b) => a.voice_sec - b.voice_sec || length(a) - length(b) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return packs.map((pack, index) => ({ ...pack, sort: (index + 1) * 10 }));
}

/** The pack columns its terms hash covers, besides the price and currency: everything a buyer gets. */
export const billingPackTermColumns = ["voice_sec", "days", "sms_seg", "calls_out", "chat_units", "kb_bytes", "numbers", "receptionists"] as const satisfies ReadonlyArray<keyof ResolvedBillingPack>;

/** The text a pack's terms hash is the SHA-256 of. It leaves out names and sort, which may change at any time. */
export function packTermsJson(pack: Pick<ResolvedBillingPack, (typeof billingPackTermColumns)[number] | "price">): string {
  return canonicalJson({
    ...Object.fromEntries(billingPackTermColumns.map((column) => [column, pack[column]])),
    currency: pack.price.currency,
    cents: pack.price.cents,
  });
}

/**
 * The plan columns its terms hash covers, besides prices and currency.
 * receptionists stays out: Polar never sees it, and adding it would change
 * the hash of every plan applied before receptionists, which a plan with
 * subscribers refuses.
 */
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
