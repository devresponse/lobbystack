import { sql } from "drizzle-orm";

import { withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import {
  billingIntervals,
  builtInBillingPlanList,
  cloudBillingPlanSlugs,
  hostedCheckoutPlanSlugs,
  type ApiBillingPlans,
  type BillingInterval,
  type BillingPlanList,
  type BillingPlanOffer,
  type CloudBillingPlanSlug,
  type HostedCheckoutPlanSlug,
} from "@lobbystack/shared";

import type { DomainContext } from "./context";

// The billing catalog as checkout, plan changes, Polar's webhook and the plan
// screens read it at run time. Standard plans are the rows whose code is their
// tier. A deployment that hasn't applied a billing.json has no rows, so it
// shows the plans this build ships with and sells through the four
// POLAR_<PLAN>_<INTERVAL>_PRODUCT_ID variables, as before the catalog. Limits
// still read billingPlanCatalog, which a test keeps equal to billing.json.

type Row = Record<string, unknown>;

/** A standard plan's row: the columns the screens read. */
export type CatalogStandardPlan = {
  code: CloudBillingPlanSlug;
  status: "draft" | "active" | "retired";
  sold: boolean;
  custom: boolean;
  overage: boolean;
  voice_sec: number | null;
  sms_seg: number | null;
  calls_out: number | null;
  chat_units: number | null;
  kb_bytes: number | null;
  numbers: number | null;
  voice_rate: number | null;
  sms_rate: number | null;
  call_rate: number | null;
  sort: number;
};

/** A price of any plan the caller may read, with its plan's tier and status, retired prices too. */
export type CatalogPrice = {
  plan: string;
  tier: string;
  status: string;
  period: BillingInterval;
  currency: string;
  cents: number;
  per_month: number;
  polar_id: string | null;
  retired: boolean;
};

export type BillingCatalogSnapshot = { plans: CatalogStandardPlan[]; prices: CatalogPrice[] };

const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/**
 * The standard plans and every price, as the role running the transaction may
 * read them: the app reads public plans only, the worker every plan.
 */
export async function readBillingCatalogSnapshot(tx: DatabaseTransaction): Promise<BillingCatalogSnapshot> {
  const plans = (await tx.execute<Row>(sql`select code, status, sold, custom, overage, voice_sec, sms_seg, calls_out, chat_units, kb_bytes, numbers, voice_rate, sms_rate, call_rate, sort from public.billing_plans where code = tier order by sort, code`)).rows;
  const prices = (await tx.execute<Row>(sql`select r.plan, p.tier, p.status, r.period, r.currency, r.cents, r.per_month, r.polar_id, r.retired_at from public.billing_prices r join public.billing_plans p on p.code = r.plan order by r.plan, r.period, r.retired_at nulls first`)).rows;
  return {
    plans: plans.map((row) => ({
      code: row.code as CloudBillingPlanSlug,
      status: row.status as CatalogStandardPlan["status"],
      sold: Boolean(row.sold),
      custom: Boolean(row.custom),
      overage: Boolean(row.overage),
      voice_sec: numberOrNull(row.voice_sec),
      sms_seg: numberOrNull(row.sms_seg),
      calls_out: numberOrNull(row.calls_out),
      chat_units: numberOrNull(row.chat_units),
      // bigint arrives as text.
      kb_bytes: numberOrNull(row.kb_bytes),
      numbers: numberOrNull(row.numbers),
      voice_rate: numberOrNull(row.voice_rate),
      sms_rate: numberOrNull(row.sms_rate),
      call_rate: numberOrNull(row.call_rate),
      sort: Number(row.sort),
    })),
    prices: prices.map((row) => ({
      plan: String(row.plan),
      tier: String(row.tier),
      status: String(row.status),
      period: row.period as BillingInterval,
      currency: String(row.currency),
      cents: Number(row.cents),
      per_month: Number(row.per_month),
      polar_id: (row.polar_id ?? null) as string | null,
      retired: row.retired_at !== null && row.retired_at !== undefined,
    })),
  };
}

/** Which Polar product sells a plan and interval, and which plan and interval a product sells. */
export type PolarProductLinks = {
  productFor(plan: HostedCheckoutPlanSlug, interval: BillingInterval): string | null;
  planFor(productId: string | null | undefined): { plan: HostedCheckoutPlanSlug; interval: BillingInterval } | null;
};

function productVariable(env: Record<string, string | undefined>, plan: HostedCheckoutPlanSlug, interval: BillingInterval): string | null {
  return env[`POLAR_${plan.toUpperCase()}_${interval.toUpperCase()}_PRODUCT_ID`]?.trim() || null;
}

const isCheckoutPlan = (value: string): value is HostedCheckoutPlanSlug => (hostedCheckoutPlanSlugs as readonly string[]).includes(value);

/**
 * The catalog's Polar links, with the product variables behind them. A
 * standard plan the link made active sells only through the products linked
 * to its live prices, so a price nobody linked yet sells nothing. Before that,
 * a plan sells through its variable. A product names the tier of the plan
 * whose price it sells, a retired price too, so a subscriber on an old
 * product keeps their plan; one the catalog doesn't know falls back to the
 * variables.
 */
export function polarProductLinks(catalog: BillingCatalogSnapshot, env: Record<string, string | undefined>): PolarProductLinks {
  return {
    productFor(plan, interval) {
      const row = catalog.plans.find((entry) => entry.code === plan);
      if (row?.status !== "active") return productVariable(env, plan, interval);
      return catalog.prices.find((price) => price.plan === plan && price.period === interval && !price.retired)?.polar_id ?? null;
    },
    planFor(productId) {
      if (!productId) return null;
      const linked = catalog.prices.find((price) => price.polar_id === productId);
      if (linked) return isCheckoutPlan(linked.tier) ? { plan: linked.tier, interval: linked.period } : null;
      for (const plan of hostedCheckoutPlanSlugs) {
        for (const interval of billingIntervals) {
          if (productVariable(env, plan, interval) === productId) return { plan, interval };
        }
      }
      return null;
    },
  };
}

/**
 * The plan list the screens and the API show. From the catalog once it holds
 * a Starter or Pro row, in its currency; before that, the built-in plans in
 * US dollars. A price can start a checkout when checkout is set up for the
 * caller and a Polar product sells it.
 */
export function billingPlanList(catalog: BillingCatalogSnapshot, options: { checkout: boolean; links: PolarProductLinks }): BillingPlanList {
  const available = (plan: HostedCheckoutPlanSlug, interval: BillingInterval) => options.checkout && options.links.productFor(plan, interval) !== null;
  const builtIn = builtInBillingPlanList(available);
  if (!catalog.plans.some((plan) => isCheckoutPlan(plan.code))) return builtIn;
  const live = catalog.prices.filter((price) => !price.retired && price.plan === price.tier);
  const currency = live[0]?.currency ?? builtIn.currency;
  const plans = cloudBillingPlanSlugs.map((slug): BillingPlanOffer => {
    const row = catalog.plans.find((plan) => plan.code === slug);
    // A tier the caller can't read, such as hidden Enterprise for the app: its built-in terms, unpriced.
    if (!row) return { ...builtIn.plans.find((plan) => plan.slug === slug)!, prices: [] };
    return {
      slug,
      custom: row.custom,
      overagesBillable: row.overage,
      included: { voiceSeconds: row.voice_sec, alertSmsSegments: row.sms_seg, outboundCallAttempts: row.calls_out, chatAiUnits: row.chat_units, knowledgeStorageBytes: row.kb_bytes, businessNumbers: row.numbers },
      overageRates: { voiceMinuteCents: row.voice_rate, alertSmsSegmentCents: row.sms_rate, outboundCallAttemptCents: row.call_rate },
      sortOrder: row.sort,
      prices: !row.sold ? [] : billingIntervals.flatMap((interval) => {
        const price = live.find((entry) => entry.plan === slug && entry.period === interval);
        return price ? [{ interval, currency: price.currency, amountCents: price.cents, monthlyAmountCents: price.per_month, checkoutAvailable: isCheckoutPlan(slug) && available(slug, interval) }] : [];
      }),
    };
  });
  return { currency, source: "catalog", plans: plans.sort((a, b) => a.sortOrder - b.sortOrder) };
}

/** Whether this deployment has Polar's token and organization, which every checkout needs. */
export function polarCheckoutConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env.POLAR_ACCESS_TOKEN && env.POLAR_ORGANIZATION_ID);
}

/** The catalog and its Polar links, read once in the caller's transaction. */
export async function loadBillingCatalog(tx: DatabaseTransaction, env: Record<string, string | undefined>): Promise<{ catalog: BillingCatalogSnapshot; links: PolarProductLinks }> {
  const catalog = await readBillingCatalogSnapshot(tx);
  return { catalog, links: polarProductLinks(catalog, env) };
}

/** The Polar links as the worker reads them, every plan included. */
export async function readPolarProductLinks(context: DomainContext, env: Record<string, string | undefined> = process.env): Promise<PolarProductLinks> {
  const catalog = await withBusinessTransaction(context.db, { actorType: "worker" }, readBillingCatalogSnapshot, { accessMode: "read only" });
  return polarProductLinks(catalog, env);
}

/** GET /billing/plans: the plans this deployment sells, as any key may see them. */
export async function listBillingPlansForApi(context: DomainContext, env: Record<string, string | undefined> = process.env): Promise<ApiBillingPlans> {
  const { catalog, links } = await withBusinessTransaction(context.db, { actorType: "worker" }, (tx) => loadBillingCatalog(tx, env), { accessMode: "read only" });
  const list = billingPlanList(catalog, { checkout: polarCheckoutConfigured(env), links });
  return {
    currency: list.currency,
    source: list.source,
    plans: list.plans.map((plan) => ({
      slug: plan.slug,
      custom: plan.custom,
      overage_billable: plan.overagesBillable,
      included: {
        voice_seconds: plan.included.voiceSeconds,
        alert_sms_segments: plan.included.alertSmsSegments,
        outbound_call_attempts: plan.included.outboundCallAttempts,
        chat_ai_units: plan.included.chatAiUnits,
        knowledge_storage_bytes: plan.included.knowledgeStorageBytes,
        business_numbers: plan.included.businessNumbers,
      },
      overage_rates: {
        voice_minute_cents: plan.overageRates.voiceMinuteCents,
        alert_sms_segment_cents: plan.overageRates.alertSmsSegmentCents,
        outbound_call_attempt_cents: plan.overageRates.outboundCallAttemptCents,
      },
      sort: plan.sortOrder,
      prices: plan.prices.map((price) => ({ interval: price.interval, currency: price.currency, amount_cents: price.amountCents, monthly_amount_cents: price.monthlyAmountCents, checkout_available: price.checkoutAvailable })),
    })),
  };
}
