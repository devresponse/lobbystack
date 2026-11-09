import type { OverageKind } from "@lobbystack/providers/billing/types";
import type { StripeCatalogMeter, StripeCatalogPrice, StripeCatalogProduct, StripeCatalogStep, StripeMetadata, StripePortalConfiguration, StripeRef, StripeSnapshot } from "@lobbystack/providers/stripe/catalog";
import { STRIPE_API_VERSION, STRIPE_METER_ERROR_EVENTS, STRIPE_WEBHOOK_EVENTS, stripeOverageMeterEvents, trimTrailingSlashes, type ApiBillingCatalog, type BillingCatalogLinkRequest, type BillingCheckCode, type BillingInterval, type BillingProfile, type BillingProviderEnv, type ResolvedBillingDiscount } from "@lobbystack/shared";

import type { DesiredBillingPack, DesiredBillingPlan } from "./billingCatalog";
import { billingPlanLabel } from "./billingPolar";
import type { CatalogDesiredInput, CatalogPlanner, CatalogPlanOptions } from "./billingProvider";
import { fileAndPostgresChecks, type AddBillingCheck, type BillingCheckResult, type BillingVerifyResult } from "./billingVerify";

// What a billing.json makes Stripe sell, the calls that get it there, what a
// link records and what verify checks (the Stripe plan's step 10). Pure, like
// billingPolar.ts: the plan is computed from a snapshot of the account, so
// the rules are tested without Stripe, and pnpm billing (step 11) and the
// worker's daily check read the same plan.
//
// Objects of a brand carry its name in their metadata, so cells of one brand
// can share an account and another brand's objects are never touched. Stripe
// never changes a price or a coupon: new terms make a new price under a new
// lookup key and a new coupon under a new ID, and the old ones are archived
// or deleted only with --allow-archive, while their subscribers keep them.
// The three overage meters, products and prices are the account's, the same
// for every brand, and found by their event names and lookup keys. A prepaid
// pack is a product of its own with one one-time price, under a lookup key
// of its own shape, so a pack and a plan never take each other's objects.

/** The path under the dashboard's address that Stripe's webhook endpoint calls. */
export const STRIPE_WEBHOOK_PATH = "/api/webhooks/stripe";
/** Under the webhook's address: where Stripe sends its meter error events. */
export const STRIPE_METER_ERRORS_SUFFIX = "/meter-errors";

/** The metadata keys LobbyStack writes on Stripe objects. */
export const stripeTags = {
  brand: "lobbystack_brand",
  plan: "lobbystack_plan",
  interval: "lobbystack_interval",
  terms: "lobbystack_terms",
  overage: "lobbystack_overage",
  pack: "lobbystack_pack",
} as const;

/** Each kind of overage: the meter its dollars are counted on, and the product its invoice lines are named after. */
export const stripeOverageSpecs = [
  { kind: "voice", event: stripeOverageMeterEvents.voice, meter: "Voice overage in dollars", product: "Voice minutes past the allowance" },
  { kind: "alert_sms", event: stripeOverageMeterEvents.alert_sms, meter: "Alert SMS overage in dollars", product: "Alert SMS past the allowance" },
  { kind: "transfer", event: stripeOverageMeterEvents.transfer, meter: "Call transfer overage in dollars", product: "Call transfers past the allowance" },
] as const satisfies ReadonlyArray<{ kind: OverageKind; event: string; meter: string; product: string }>;

/** A meter unit is a dollar of overage, so an overage price is 100 cents a unit. */
export const STRIPE_OVERAGE_UNIT_CENTS = 100;
/** The meter event payload's keys: the customer's ID, and the dollars. */
export const STRIPE_METER_CUSTOMER_KEY = "stripe_customer_id";
export const STRIPE_METER_VALUE_KEY = "value";

/** A plan price's lookup key: brand, plan, period, currency and the first 8 of the plan's terms hash. New terms make a new key. */
export const stripePriceLookupKey = (brand: string, plan: string, period: BillingInterval, currency: string, terms: string) => `ls_${brand}_${plan}_${period}_${currency}_${terms.slice(0, 8)}`;
/**
 * A pack price's lookup key: brand, pack, currency and the first 8 of the
 * pack's terms hash. Its prefix is its own, since under the plans' one pack
 * x_monthly's key would be plan x's.
 */
export const stripePackLookupKey = (brand: string, pack: string, currency: string, terms: string) => `lsp_${brand}_${pack}_${currency}_${terms.slice(0, 8)}`;
/** An overage price's lookup key: its meter's event name and the currency. */
export const stripeOverageLookupKey = (event: string, currency: string) => `${event}_${currency}`;
/** A plan's coupon ID: brand, plan and the first 8 of its terms hash. */
export const stripeCouponId = (brand: string, plan: string, terms: string) => `ls-${brand}-${plan}-${terms.slice(0, 8)}`;

export type DesiredStripeProduct = { plan: string; name: string };
export type DesiredStripePrice = { plan: string; period: BillingInterval; lookupKey: string; cents: number; currency: string; interval: "month" | "year"; terms: string };
export type DesiredStripeOverage = { kind: OverageKind; event: string; meterName: string; productName: string; lookupKey: string };
export type DesiredStripeCoupon = { plan: string; id: string; name: string; terms: string; currency: string; discount: ResolvedBillingDiscount };
/** A prepaid pack: a product of its own and a one-time price under its lookup key. */
export type DesiredStripePack = { pack: string; name: string; lookupKey: string; cents: number; currency: string; terms: string };
export type DesiredStripePortal = {
  /** Settings > Plan. Null when the dashboard's address isn't known, and then left as it is. */
  returnUrl: string | null;
  /** The brand's pages. Null leaves Stripe's as they are. */
  termsUrl: string | null;
  privacyUrl: string | null;
  planChanges: boolean;
  cancel: boolean;
  upgrade: "invoice" | "prorate" | "reset";
  downgrade: "next_period" | "invoice" | "prorate";
  /** The standard plans the portal switches between. */
  plans: string[];
};

/** Everything one brand's file makes Stripe sell. */
export type DesiredStripeCatalog = {
  brand: string;
  currency: string;
  taxCode: string;
  managedPayments: boolean;
  overageMode: "separate" | "checkout";
  usageGraceHours: number;
  products: DesiredStripeProduct[];
  prices: DesiredStripePrice[];
  overage: DesiredStripeOverage[];
  coupons: DesiredStripeCoupon[];
  /** Empty for a file without packs. */
  packs: DesiredStripePack[];
  portal: DesiredStripePortal;
  /** Null when the instance's address isn't known, as on a worker without APP_BASE_URL: neither is then set up nor checked. */
  webhook: { url: string; events: string[] } | null;
  meterErrors: { url: string; events: string[] } | null;
};

const trimUrl = (url: string) => trimTrailingSlashes(url.trim());
const priceKey = (plan: string, period: string) => `${plan}/${period}`;

/**
 * The Stripe objects a checked file needs: a product per sold plan (a promo
 * plan has its own, since the portal can't hold two prices of one product
 * with the same interval), a price per live price, the three overage
 * meters, products and prices, a coupon per discounted plan, a product and a
 * one-time price per pack, the billing portal's configuration, the webhook
 * endpoint and the meter error destination.
 */
export function desiredStripeCatalog(input: CatalogDesiredInput): DesiredStripeCatalog {
  const block = input.profile.stripe;
  // The apply refuses such a file on a Stripe deployment (provider_block_missing).
  if (!block) throw new Error(`brands/${input.brand}/billing.json has no stripe block, which a Stripe deployment needs.`);
  const currency = input.profile.currency;
  const products: DesiredStripeProduct[] = [];
  const prices: DesiredStripePrice[] = [];
  const coupons: DesiredStripeCoupon[] = [];
  for (const plan of input.plans) {
    if (!plan.sold || !plan.prices.length) continue;
    const label = billingPlanLabel(plan);
    products.push({ plan: plan.code, name: label });
    for (const price of plan.prices) {
      prices.push({ plan: plan.code, period: price.period, lookupKey: stripePriceLookupKey(input.brand, plan.code, price.period, price.currency, plan.terms_hash), cents: price.cents, currency: price.currency, interval: price.period === "annual" ? "year" : "month", terms: plan.terms_hash });
    }
    if (plan.discount) coupons.push({ plan: plan.code, id: stripeCouponId(input.brand, plan.code, plan.terms_hash), name: `${label} discount`, terms: plan.terms_hash, currency, discount: plan.discount });
  }
  const webhookUrl = input.webhookUrl ? trimUrl(input.webhookUrl) : null;
  const portalPlans = input.plans.filter((plan) => plan.code === plan.tier && plan.access === "public" && plan.sold && plan.prices.length > 0).map((plan) => plan.code);
  return {
    brand: input.brand,
    currency,
    taxCode: block.tax.code,
    managedPayments: block.managedPayments,
    overageMode: block.overage,
    usageGraceHours: block.usageGraceHours,
    products,
    prices,
    overage: stripeOverageSpecs.map((spec) => ({ kind: spec.kind, event: spec.event, meterName: spec.meter, productName: spec.product, lookupKey: stripeOverageLookupKey(spec.event, currency) })),
    coupons,
    packs: (input.packs ?? []).map((pack) => ({ pack: pack.code, name: pack.names.en, lookupKey: stripePackLookupKey(input.brand, pack.code, pack.price.currency, pack.terms_hash), cents: pack.price.cents, currency: pack.price.currency, terms: pack.terms_hash })),
    portal: {
      returnUrl: webhookUrl ? `${new URL(webhookUrl).origin}/settings/plan` : null,
      termsUrl: input.links?.termsUrl ?? null,
      privacyUrl: input.links?.privacyUrl ?? null,
      // Stripe takes plan changes only with plans to switch between.
      planChanges: block.portalPlanChanges && portalPlans.length > 0,
      cancel: block.portalCancel,
      upgrade: block.upgrade,
      downgrade: block.downgrade,
      plans: portalPlans,
    },
    webhook: webhookUrl ? { url: webhookUrl, events: [...STRIPE_WEBHOOK_EVENTS] } : null,
    meterErrors: webhookUrl ? { url: `${webhookUrl}${STRIPE_METER_ERRORS_SUFFIX}`, events: [...STRIPE_METER_ERROR_EVENTS] } : null,
  };
}

// The plan of Stripe calls.

/** overage: the overage products and prices. meter_errors: the destination of meter error events. */
export type StripeStepObject = "meter" | "overage" | "product" | "price" | "coupon" | "portal" | "webhook" | "meter_errors";
/** restore: a product, price or meter made active again. archive: made inactive, its subscribers keep it. */
export type StripeStepAction = "create" | "update" | "restore" | "archive" | "delete";

export type StripeStep = StripeCatalogStep & {
  object: StripeStepObject;
  action: StripeStepAction;
  subject: string;
  /** What the call changes, one line each, as people read it. */
  changes: string[];
  /** It archives or deletes an object tagged for this brand that the file no longer names. */
  leftover?: boolean;
};

export type StripeRefusal = { object: StripeStepObject; subject: string; message: string };
export type StripePlan = { steps: StripeStep[]; refusals: StripeRefusal[] };

// The ref shape packages/providers/src/stripe/catalog.ts's runner resolves.
const ref = (name: string): StripeRef => ({ $ref: name });
const isRef = (value: unknown): value is StripeRef => Boolean(value && typeof value === "object" && "$ref" in value);
/** An ID the snapshot holds equals the wanted one; a ref, made later in the run, never does. */
const sameId = (wanted: string | StripeRef, found: string | null | undefined) => !isRef(wanted) && wanted === found;

function money(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

function quoted(items: ReadonlyArray<{ name?: string | null; id: string }>): string {
  return items.map((item) => `"${item.name ?? item.id}"`).join(", ");
}

function newest<T extends { created: number }>(items: readonly T[]): T | undefined {
  return [...items].sort((a, b) => b.created - a.created)[0];
}

/** The tags to send: Stripe merges metadata on update, so only the keys that differ. Null when they all match. */
function changedTags(existing: StripeMetadata, tags: StripeMetadata): StripeMetadata | null {
  const changed = Object.fromEntries(Object.entries(tags).filter(([key, value]) => existing[key] !== value));
  return Object.keys(changed).length ? changed : null;
}

const meterMatches = (meter: StripeCatalogMeter) => meter.default_aggregation.formula === "sum" && meter.customer_mapping.type === "by_id" && meter.customer_mapping.event_payload_key === STRIPE_METER_CUSTOMER_KEY && meter.value_settings.event_payload_key === STRIPE_METER_VALUE_KEY;

/** interval null: a one-time price, as a pack's. */
type WantedPrice = { product: string | StripeRef; currency: string; cents: number; interval: "month" | "year" | null; meter: string | StripeRef | null };

/** Why a price can't sell what's wanted: Stripe never changes its product, amount, currency, cycle, usage type or meter. Null when it can. */
function priceProblem(found: StripeCatalogPrice, wanted: WantedPrice): string | null {
  const problems: string[] = [];
  if (!sameId(wanted.product, found.product)) problems.push(`belongs to product ${found.product}`);
  if (found.currency !== wanted.currency || found.unit_amount !== wanted.cents) problems.push(`costs ${money(found.unit_amount ?? 0, found.currency)}`);
  const recurring = found.recurring;
  if (wanted.interval === null) {
    if (recurring) problems.push(`bills every ${recurring.interval_count} ${recurring.interval}, while a pack is paid once`);
  } else if (!recurring) problems.push("isn't recurring");
  else {
    if (recurring.interval !== wanted.interval || recurring.interval_count !== 1) problems.push(`bills every ${recurring.interval_count} ${recurring.interval}`);
    const usage = wanted.meter === null ? "licensed" : "metered";
    if (recurring.usage_type !== usage) problems.push(`is ${recurring.usage_type}`);
    else if (wanted.meter !== null && !sameId(wanted.meter, recurring.meter)) problems.push(`counts meter ${recurring.meter ?? "none"}`);
  }
  // Stripe sets a tax behavior once: unspecified can still become exclusive.
  if (found.tax_behavior === "inclusive") problems.push("includes tax");
  return problems.length ? problems.join(", ") : null;
}

// reset invoices the change at once too, and starts a new cycle (billing_cycle_anchor now).
const prorationFor = { invoice: "always_invoice", prorate: "create_prorations", reset: "always_invoice" } as const;

/** The billing portal's features as the file wants them. */
function portalFeatures(portal: DesiredStripePortal, products: Array<{ product: string | StripeRef; prices: Array<string | StripeRef> }>) {
  return {
    customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id"] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: portal.cancel ? { enabled: true, mode: "at_period_end", proration_behavior: "none" } : { enabled: false },
    // An upgrade charges as the file says, reset starting a new cycle; a downgrade waits for the period's end when the file says next_period.
    subscription_update: portal.planChanges
      ? {
          enabled: true,
          default_allowed_updates: ["price"],
          products,
          proration_behavior: prorationFor[portal.upgrade],
          billing_cycle_anchor: portal.upgrade === "reset" ? "now" : "unchanged",
          schedule_at_period_end: { conditions: portal.downgrade === "next_period" ? [{ type: "decreasing_item_amount" }, { type: "shortening_interval" }] : [] },
        }
      : { enabled: false },
  };
}

const sortedText = (items: readonly string[]) => [...items].sort().join(",");

/** What differs between a portal configuration's features and the wanted ones, as people read it. */
function portalFeatureChanges(found: StripePortalConfiguration["features"], portal: DesiredStripePortal, products: Array<{ product: string | StripeRef; prices: Array<string | StripeRef> }>): string[] {
  const changes: string[] = [];
  if (!found.customer_update.enabled || sortedText(found.customer_update.allowed_updates) !== sortedText(["email", "address", "tax_id"])) changes.push("customers change their email, address and tax ID");
  if (!found.invoice_history.enabled || !found.payment_method_update.enabled) changes.push("customers see their invoices and change their card");
  const cancel = found.subscription_cancel;
  if (cancel.enabled !== portal.cancel) changes.push(portal.cancel ? "cancelling is off, the file turns it on" : "cancelling is on, the file turns it off: Settings > Plan cancels");
  else if (portal.cancel && (cancel.mode !== "at_period_end" || cancel.proration_behavior !== "none")) changes.push("a cancellation waits for the period's end, with nothing prorated");
  const update = found.subscription_update;
  if (update.enabled !== portal.planChanges) changes.push(portal.planChanges ? "plan changes are off, the file turns them on" : "plan changes are on, the file turns them off");
  else if (portal.planChanges) {
    if (sortedText(update.default_allowed_updates) !== "price") changes.push("customers change only the plan's price");
    const conditions = portal.downgrade === "next_period" ? ["decreasing_item_amount", "shortening_interval"] : [];
    if (update.proration_behavior !== prorationFor[portal.upgrade] || (update.billing_cycle_anchor ?? "unchanged") !== (portal.upgrade === "reset" ? "now" : "unchanged")) changes.push(`an upgrade charges as upgrade ${portal.upgrade} says`);
    if (sortedText(update.schedule_at_period_end.conditions.map((condition) => condition.type)) !== sortedText(conditions)) changes.push(portal.downgrade === "next_period" ? "a downgrade waits for the period's end" : "a downgrade takes effect at once");
    const wanted = products.map((entry) => `${isRef(entry.product) ? "?" : entry.product}:${sortedText(entry.prices.map((price) => (isRef(price) ? "?" : price)))}`);
    const current = (update.products ?? []).map((entry) => `${entry.product}:${sortedText(entry.prices)}`);
    if (products.some((entry) => isRef(entry.product) || entry.prices.some(isRef)) || sortedText(wanted) !== sortedText(current)) changes.push(`it switches between ${portal.plans.join(" and ") || "no plans"} at their live prices`);
  }
  return changes;
}

/**
 * The calls that make a Stripe account sell what the file says, in the order
 * they run: meters, the overage products and prices, the plans' products and
 * prices, coupons, the billing portal, the webhook endpoint and the meter
 * error destination, the packs' products and prices, then archiving and
 * deleting. Anything the run must not decide on its own is a refusal
 * instead, and a run with refusals makes no call at all.
 */
export function planStripeChanges(input: { catalog: DesiredStripeCatalog; snapshot: StripeSnapshot; options: CatalogPlanOptions }): StripePlan {
  const { catalog, snapshot, options } = input;
  const steps: StripeStep[] = [];
  const late: StripeStep[] = [];
  const refusals: StripeRefusal[] = [];
  const refuse = (object: StripeStepObject, subject: string, message: string) => refusals.push({ object, subject, message });
  const ours = (metadata: StripeMetadata) => metadata[stripeTags.brand] === catalog.brand;
  const idempotencyKey = (object: string, name: string) => `catalog:${catalog.brand}:${object}:${name}`;
  const brandTag = { [stripeTags.brand]: catalog.brand };

  // Meters, found by their event names: a meter carries no metadata.
  const meterIds = new Map<OverageKind, string | StripeRef>();
  for (const overage of catalog.overage) {
    const subject = `Meter "${overage.meterName}"`;
    const named = snapshot.meters.filter((meter) => meter.event_name === overage.event);
    const active = named.filter((meter) => meter.status === "active");
    if (active.length && !active.some(meterMatches)) {
      refuse("meter", subject, `${quoted(active.map((meter) => ({ id: meter.id, name: meter.display_name })))} counts ${overage.event}, but not as a sum of ${STRIPE_METER_VALUE_KEY} by ${STRIPE_METER_CUSTOMER_KEY}, and Stripe never changes that. Deactivate it in Stripe's Dashboard and run again.`);
      continue;
    }
    const found = active.find(meterMatches) ?? named.find(meterMatches);
    if (!found) {
      steps.push({ object: "meter", action: "create", subject, changes: [`sum of ${STRIPE_METER_VALUE_KEY} in dollars where the event is ${overage.event}, by ${STRIPE_METER_CUSTOMER_KEY}`], call: "billing.meters.create", params: { display_name: overage.meterName, event_name: overage.event, default_aggregation: { formula: "sum" }, customer_mapping: { type: "by_id", event_payload_key: STRIPE_METER_CUSTOMER_KEY }, value_settings: { event_payload_key: STRIPE_METER_VALUE_KEY } }, idempotencyKey: idempotencyKey("meter", overage.event), produces: `meter:${overage.kind}` });
      meterIds.set(overage.kind, ref(`meter:${overage.kind}`));
      continue;
    }
    if (found.status === "inactive") steps.push({ object: "meter", action: "restore", subject, changes: ["reactivate it: overage is counted on it"], call: "billing.meters.reactivate", target: found.id, params: {} });
    if (found.display_name !== overage.meterName) steps.push({ object: "meter", action: "update", subject, changes: [`named "${found.display_name}", the code says "${overage.meterName}"`], call: "billing.meters.update", target: found.id, params: { display_name: overage.meterName } });
    meterIds.set(overage.kind, found.id);
  }

  /** A product found by its tags, brought back when archived, renamed and given the file's tax code. */
  const planProduct = (spec: { object: "product" | "overage"; name: string; candidates: StripeCatalogProduct[]; tags: StripeMetadata; produces: string; key: string }): string | StripeRef | null => {
    const subject = `Product "${spec.name}"`;
    const live = spec.candidates.filter((product) => product.active);
    if (live.length > 1) {
      refuse(spec.object, subject, `${live.length} live products are tagged for it (${quoted(live)}). Archive all but one in Stripe's Dashboard.`);
      return null;
    }
    const found = live[0] ?? newest(spec.candidates);
    if (!found) {
      steps.push({ object: spec.object, action: "create", subject, changes: [`tax code ${catalog.taxCode}`], call: "products.create", params: { name: spec.name, tax_code: catalog.taxCode, metadata: spec.tags }, idempotencyKey: idempotencyKey("product", spec.key), produces: spec.produces });
      return ref(spec.produces);
    }
    const params: Record<string, unknown> = {};
    const changes: string[] = [];
    if (!found.active) {
      params.active = true;
      changes.push("bring it back: the file sells it again");
    }
    if (found.name !== spec.name) {
      params.name = spec.name;
      changes.push(`named "${found.name}", the file says "${spec.name}"`);
    }
    if (found.tax_code !== catalog.taxCode) {
      params.tax_code = catalog.taxCode;
      changes.push(`tax code ${found.tax_code ?? "none"}, the file says ${catalog.taxCode}`);
    }
    const tags = changedTags(found.metadata, spec.tags);
    if (tags) {
      params.metadata = tags;
      changes.push("tag it as LobbyStack's");
    }
    if (Object.keys(params).length) steps.push({ object: spec.object, action: found.active ? "update" : "restore", subject, changes, call: "products.update", target: found.id, params });
    return found.id;
  };

  /** Prices replaced in this run: their archive step is already planned. */
  const replacedPrices = new Set<string>();
  /** A price found by its lookup key; Stripe never changes one, so a price that can't sell what's wanted is replaced under the same key. */
  const planPrice = (spec: { object: "price" | "overage"; lookupKey: string; wanted: WantedPrice; describe: string; tags: StripeMetadata; produces: string }): string | StripeRef | null => {
    const subject = `Price ${spec.lookupKey}`;
    const found = snapshot.prices.find((price) => price.lookup_key === spec.lookupKey);
    // A one-time price is sent without recurring.
    const recurring = spec.wanted.interval === null ? {} : { recurring: { interval: spec.wanted.interval, ...(spec.wanted.meter !== null ? { usage_type: "metered", meter: spec.wanted.meter } : {}) } };
    const params = { product: spec.wanted.product, currency: spec.wanted.currency, unit_amount: spec.wanted.cents, ...recurring, lookup_key: spec.lookupKey, tax_behavior: "exclusive", metadata: spec.tags };
    if (!found) {
      steps.push({ object: spec.object, action: "create", subject, changes: [spec.describe], call: "prices.create", params, idempotencyKey: idempotencyKey("price", spec.lookupKey), produces: spec.produces });
      return ref(spec.produces);
    }
    const owner = found.metadata[stripeTags.brand];
    if (owner !== undefined && owner !== catalog.brand) {
      refuse(spec.object, subject, `${found.id}, tagged for ${owner}, holds this lookup key. Use a Stripe account of ${catalog.brand}'s own.`);
      return null;
    }
    const problem = priceProblem(found, spec.wanted);
    if (problem) {
      // A one-time price has buyers, not subscribers.
      const once = spec.wanted.interval === null;
      if (!options.allowReplace) {
        refuse(spec.object, subject, `${found.id} ${problem}, and Stripe never changes a price. Run with --allow-replace to make a new price that takes over the lookup key; ${once ? "packs bought through the old one keep their minutes" : "its subscribers keep the old one"}.`);
        return null;
      }
      steps.push({ object: spec.object, action: "create", subject, changes: [`replaces ${found.id}, which ${problem}: ${spec.describe}`], call: "prices.create", params: { ...params, transfer_lookup_key: true }, idempotencyKey: idempotencyKey("price", `${spec.lookupKey}:after:${found.id}`), produces: spec.produces });
      replacedPrices.add(found.id);
      if (found.active) late.push({ object: spec.object, action: "archive", subject: `Price ${found.id}`, changes: [`replaced under ${spec.lookupKey}; ${once ? "packs bought through it keep their minutes" : "its subscribers keep it"}`], call: "prices.update", target: found.id, params: { active: false } });
      return ref(spec.produces);
    }
    const update: Record<string, unknown> = {};
    const changes: string[] = [];
    if (!found.active) {
      update.active = true;
      changes.push("bring it back: the file sells it again");
    }
    if (found.tax_behavior !== "exclusive") {
      update.tax_behavior = "exclusive";
      changes.push("tax behavior unspecified, the file says before tax");
    }
    const tags = changedTags(found.metadata, spec.tags);
    if (tags) {
      update.metadata = tags;
      changes.push("tag it as LobbyStack's");
    }
    if (Object.keys(update).length) steps.push({ object: spec.object, action: found.active ? "update" : "restore", subject, changes, call: "prices.update", target: found.id, params: update });
    return found.id;
  };

  // The overage products and prices: the account's, the same for every brand.
  const overagePrices = new Map<OverageKind, string | StripeRef>();
  for (const overage of catalog.overage) {
    const product = planProduct({ object: "overage", name: overage.productName, candidates: snapshot.products.filter((entry) => entry.metadata[stripeTags.overage] === overage.kind), tags: { [stripeTags.overage]: overage.kind }, produces: `overage-product:${overage.kind}`, key: `overage:${overage.kind}` });
    const meter = meterIds.get(overage.kind);
    if (product === null || meter === undefined) continue;
    const price = planPrice({ object: "overage", lookupKey: overage.lookupKey, wanted: { product, currency: catalog.currency, cents: STRIPE_OVERAGE_UNIT_CENTS, interval: "month", meter }, describe: `${money(STRIPE_OVERAGE_UNIT_CENTS, catalog.currency)} a unit, a unit being a dollar of overage, invoiced monthly`, tags: { [stripeTags.overage]: overage.kind }, produces: `overage-price:${overage.kind}` });
    if (price !== null) overagePrices.set(overage.kind, price);
  }

  // The plans' products and prices.
  const productIds = new Map<string, string | StripeRef>();
  for (const desired of catalog.products) {
    const product = planProduct({ object: "product", name: desired.name, candidates: snapshot.products.filter((entry) => ours(entry.metadata) && entry.metadata[stripeTags.plan] === desired.plan), tags: { ...brandTag, [stripeTags.plan]: desired.plan }, produces: `product:${desired.plan}`, key: desired.plan });
    if (product !== null) productIds.set(desired.plan, product);
  }
  const priceIds = new Map<string, string | StripeRef>();
  for (const desired of catalog.prices) {
    const product = productIds.get(desired.plan);
    if (product === undefined) continue;
    const price = planPrice({ object: "price", lookupKey: desired.lookupKey, wanted: { product, currency: desired.currency, cents: desired.cents, interval: desired.interval, meter: null }, describe: `${money(desired.cents, desired.currency)} a ${desired.interval}, before tax`, tags: { ...brandTag, [stripeTags.plan]: desired.plan, [stripeTags.interval]: desired.period, [stripeTags.terms]: desired.terms }, produces: `price:${priceKey(desired.plan, desired.period)}` });
    if (price !== null) priceIds.set(priceKey(desired.plan, desired.period), price);
  }

  // Prices and products of this brand that the file no longer sells. A pack's
  // are judged against the file's packs, a plan's against its plans.
  const wantedKeys = new Set([...catalog.prices.map((price) => price.lookupKey), ...catalog.packs.map((pack) => pack.lookupKey)]);
  for (const price of snapshot.prices) {
    if (!price.active || !ours(price.metadata) || (price.lookup_key !== null && wantedKeys.has(price.lookup_key)) || replacedPrices.has(price.id)) continue;
    const subject = `Price ${price.lookup_key ?? price.id}`;
    const pack = price.metadata[stripeTags.pack];
    if (pack !== undefined) {
      if (!options.allowArchive) refuse("price", subject, `It sells pack ${pack} at ${money(price.unit_amount ?? 0, price.currency)} on terms the file no longer has. Run with --allow-archive to archive it; packs bought through it keep their minutes.`);
      else late.push({ object: "price", action: "archive", subject, changes: ["the file no longer sells it; packs bought through it keep their minutes"], leftover: true, call: "prices.update", target: price.id, params: { active: false } });
      continue;
    }
    const sells = `${price.metadata[stripeTags.plan] ?? "a plan"} ${price.metadata[stripeTags.interval] ?? ""}`.trim();
    if (!options.allowArchive) refuse("price", subject, `It sells ${sells} at ${money(price.unit_amount ?? 0, price.currency)} on terms the file no longer has. Run with --allow-archive to archive it; its subscribers keep it.`);
    else late.push({ object: "price", action: "archive", subject, changes: ["the file no longer sells it; its subscribers keep it"], leftover: true, call: "prices.update", target: price.id, params: { active: false } });
  }
  const wantedPlans = new Set(catalog.products.map((product) => product.plan));
  const wantedPacks = new Set(catalog.packs.map((pack) => pack.pack));
  for (const product of snapshot.products) {
    if (!product.active || !ours(product.metadata)) continue;
    const pack = product.metadata[stripeTags.pack];
    if (pack !== undefined ? wantedPacks.has(pack) : wantedPlans.has(String(product.metadata[stripeTags.plan]))) continue;
    const subject = `Product "${product.name}"`;
    if (pack !== undefined) {
      if (!options.allowArchive) refuse("product", subject, `It sells pack ${pack}, which the file no longer has. Run with --allow-archive to archive it; packs bought through it keep their minutes.`);
      else late.push({ object: "product", action: "archive", subject, changes: ["the file no longer sells it; packs bought through it keep their minutes"], leftover: true, call: "products.update", target: product.id, params: { active: false } });
      continue;
    }
    if (!options.allowArchive) refuse("product", subject, `It sells ${String(product.metadata[stripeTags.plan])}, which the file no longer has. Run with --allow-archive to archive it; its subscribers keep their subscription.`);
    else late.push({ object: "product", action: "archive", subject, changes: ["the file no longer sells it; its subscribers keep their subscription"], leftover: true, call: "products.update", target: product.id, params: { active: false } });
  }

  // Coupons, under IDs of their own: no promotion code, so only LobbyStack's checkout applies one.
  const couponIds = new Set(catalog.coupons.map((coupon) => coupon.id));
  for (const desired of catalog.coupons) {
    const subject = `Coupon ${desired.id}`;
    const product = productIds.get(desired.plan);
    if (product === undefined) continue;
    const discount = desired.discount;
    const amount = discount.type === "percentage" ? { percent_off: (discount.basis_points ?? 0) / 100 } : { amount_off: discount.amount_cents ?? 0, currency: desired.currency };
    const months = discount.duration === "repeating" ? { duration_in_months: discount.duration_in_months } : {};
    const tags = { ...brandTag, [stripeTags.plan]: desired.plan, [stripeTags.terms]: desired.terms };
    const off = discount.type === "percentage" ? `${(discount.basis_points ?? 0) / 100}% off` : `${money(discount.amount_cents ?? 0, desired.currency)} off`;
    const describe = `${off}, ${discount.duration === "repeating" ? `for ${discount.duration_in_months} months` : discount.duration}, on ${desired.plan}'s product only`;
    const found = snapshot.coupons.find((coupon) => coupon.id === desired.id);
    if (!found) {
      steps.push({ object: "coupon", action: "create", subject, changes: [describe], call: "coupons.create", params: { id: desired.id, name: desired.name, ...amount, duration: discount.duration, ...months, applies_to: { products: [product] }, metadata: tags }, idempotencyKey: idempotencyKey("coupon", desired.id) });
      continue;
    }
    const problems: string[] = [];
    if (discount.type === "percentage" ? found.percent_off !== (discount.basis_points ?? 0) / 100 : found.amount_off !== discount.amount_cents || found.currency !== desired.currency) problems.push(`takes ${found.percent_off !== null ? `${found.percent_off}%` : money(found.amount_off ?? 0, found.currency ?? desired.currency)} off`);
    if (found.duration !== discount.duration || (found.duration_in_months ?? null) !== (discount.duration_in_months ?? null)) problems.push(`lasts ${found.duration === "repeating" ? `${found.duration_in_months} months` : found.duration}`);
    if (!found.applies_to || found.applies_to.products.length !== 1 || !sameId(product, found.applies_to.products[0])) problems.push(found.applies_to ? `applies to ${found.applies_to.products.join(", ") || "no product"}` : "applies to every product");
    if (problems.length) {
      refuse("coupon", subject, `${found.id} ${problems.join(", ")}, and Stripe never changes a coupon. Delete it in Stripe's Dashboard and run again; those who redeemed it keep their discount.`);
      continue;
    }
    const update: Record<string, unknown> = {};
    const changes: string[] = [];
    if (found.name !== desired.name) {
      update.name = desired.name;
      changes.push(`named "${found.name ?? found.id}", the file says "${desired.name}"`);
    }
    const changed = changedTags(found.metadata, tags);
    if (changed) {
      update.metadata = changed;
      changes.push("tag it as LobbyStack's");
    }
    if (Object.keys(update).length) steps.push({ object: "coupon", action: "update", subject, changes, call: "coupons.update", target: found.id, params: update });
  }
  for (const coupon of snapshot.coupons) {
    if (!coupon.valid || !ours(coupon.metadata) || couponIds.has(coupon.id)) continue;
    const subject = `Coupon ${coupon.id}`;
    if (!options.allowArchive) refuse("coupon", subject, `The file no longer gives ${String(coupon.metadata[stripeTags.plan] ?? "its plan")} this discount. Run with --allow-archive to delete it; those who redeemed it keep their discount.`);
    else late.push({ object: "coupon", action: "delete", subject, changes: ["the file no longer has it; those who redeemed it keep their discount"], leftover: true, call: "coupons.del", target: coupon.id, params: {} });
  }

  // The billing portal: the brand's own configuration, which the link records for the portal sessions.
  const portal = catalog.portal;
  const portalProducts = portal.plans.flatMap((plan) => {
    const product = productIds.get(plan);
    if (product === undefined) return [];
    const prices = catalog.prices.filter((price) => price.plan === plan).map((price) => priceIds.get(priceKey(plan, price.period))).filter((id): id is string | StripeRef => id !== undefined);
    return [{ product, prices }];
  });
  const features = portalFeatures(portal, portalProducts);
  const profile = { ...(portal.termsUrl ? { terms_of_service_url: portal.termsUrl } : {}), ...(portal.privacyUrl ? { privacy_policy_url: portal.privacyUrl } : {}) };
  const subject = "Billing portal";
  const tagged = snapshot.portalConfigurations.filter((configuration) => ours(configuration.metadata));
  const active = tagged.filter((configuration) => configuration.active);
  if (active.length > 1) refuse("portal", subject, `${active.length} active billing portal configurations are tagged for ${catalog.brand} (${active.map((configuration) => configuration.id).join(", ")}). Deactivate all but one in Stripe's Dashboard.`);
  else {
    const found = active[0] ?? tagged[0];
    if (!found) {
      steps.push({ object: "portal", action: "create", subject, changes: [portal.planChanges ? `plan changes between ${portal.plans.join(" and ")}` : "no plan changes", portal.cancel ? "customers may cancel" : "Settings > Plan cancels"], call: "billingPortal.configurations.create", params: { name: `LobbyStack ${catalog.brand}`, ...(Object.keys(profile).length ? { business_profile: profile } : {}), ...(portal.returnUrl ? { default_return_url: portal.returnUrl } : {}), features, metadata: brandTag }, idempotencyKey: idempotencyKey("portal", catalog.brand), produces: "portal" });
    } else {
      const params: Record<string, unknown> = {};
      const changes: string[] = [];
      if (!found.active) {
        params.active = true;
        changes.push("turn it back on");
      }
      const featureChanges = portalFeatureChanges(found.features, portal, portalProducts);
      if (featureChanges.length) {
        params.features = features;
        changes.push(...featureChanges);
      }
      const profileChanges = [
        ...(portal.termsUrl && found.business_profile.terms_of_service_url !== portal.termsUrl ? [`terms page ${found.business_profile.terms_of_service_url ?? "none"}, the brand's is ${portal.termsUrl}`] : []),
        ...(portal.privacyUrl && found.business_profile.privacy_policy_url !== portal.privacyUrl ? [`privacy page ${found.business_profile.privacy_policy_url ?? "none"}, the brand's is ${portal.privacyUrl}`] : []),
      ];
      if (profileChanges.length) {
        params.business_profile = profile;
        changes.push(...profileChanges);
      }
      if (portal.returnUrl && found.default_return_url !== portal.returnUrl) {
        params.default_return_url = portal.returnUrl;
        changes.push(`returns to ${found.default_return_url ?? "nowhere"}, the dashboard's is ${portal.returnUrl}`);
      }
      if (Object.keys(params).length) steps.push({ object: "portal", action: found.active ? "update" : "restore", subject, changes, call: "billingPortal.configurations.update", target: found.id, params });
    }
  }

  // The webhook endpoint, found by its address. Its secret is shown once, when it's made.
  if (catalog.webhook) {
    const { url, events } = catalog.webhook;
    const subject = `Webhook ${url}`;
    const same = snapshot.webhooks.filter((endpoint) => trimUrl(endpoint.url) === url);
    const create = (changes: string[]) => steps.push({ object: "webhook", action: "create", subject, changes, call: "webhookEndpoints.create", params: { url, enabled_events: events, api_version: STRIPE_API_VERSION, description: "LobbyStack", metadata: brandTag }, idempotencyKey: idempotencyKey("webhook", url) });
    if (same.length > 1) refuse("webhook", subject, `${same.length} endpoints point at ${url}. Delete all but one in Stripe's Dashboard.`);
    else if (!same[0]) create([`${events.length} events, API version ${STRIPE_API_VERSION}`]);
    else {
      const endpoint = same[0];
      if (endpoint.api_version !== STRIPE_API_VERSION) {
        // Stripe never changes an endpoint's API version.
        if (!options.allowReplace) refuse("webhook", subject, `${endpoint.id} sends events in API version ${endpoint.api_version ?? "of the account"}, LobbyStack reads ${STRIPE_API_VERSION}, and Stripe never changes an endpoint's version. Run with --allow-replace to make a new endpoint and delete this one; its new secret goes to the Railway file.`);
        else {
          create([`replaces ${endpoint.id}, which sends API version ${endpoint.api_version ?? "of the account"}: ${events.length} events, API version ${STRIPE_API_VERSION}`]);
          late.push({ object: "webhook", action: "delete", subject: `Webhook ${endpoint.id}`, changes: [`replaced by an endpoint in API version ${STRIPE_API_VERSION}`], call: "webhookEndpoints.del", target: endpoint.id, params: {} });
        }
      } else {
        const params: Record<string, unknown> = {};
        const changes: string[] = [];
        if (endpoint.status !== "enabled") {
          params.disabled = false;
          changes.push("turned off");
        }
        const missing = events.filter((event) => !endpoint.enabled_events.includes(event) && !endpoint.enabled_events.includes("*"));
        if (missing.length) {
          params.enabled_events = [...endpoint.enabled_events, ...missing];
          changes.push(`add ${missing.join(", ")}`);
        }
        const tags = changedTags(endpoint.metadata, brandTag);
        if (tags) {
          params.metadata = tags;
          changes.push("tag it as LobbyStack's");
        }
        if (Object.keys(params).length) steps.push({ object: "webhook", action: "update", subject, changes, call: "webhookEndpoints.update", target: endpoint.id, params });
      }
    }
  }

  // The meter error destination: thin events, with a secret of its own.
  if (catalog.meterErrors) {
    const { url, events } = catalog.meterErrors;
    const subject = `Meter error destination ${url}`;
    const same = snapshot.eventDestinations.filter((destination) => destination.type === "webhook_endpoint" && destination.url !== null && trimUrl(destination.url) === url);
    const create = (changes: string[]) => steps.push({ object: "meter_errors", action: "create", subject, changes, call: "v2.core.eventDestinations.create", params: { name: `LobbyStack meter errors ${catalog.brand}`, description: "Meter events Stripe couldn't use", type: "webhook_endpoint", event_payload: "thin", enabled_events: events, webhook_endpoint: { url }, include: ["webhook_endpoint.signing_secret"], metadata: brandTag }, idempotencyKey: idempotencyKey("meter-errors", url) });
    if (same.length > 1) refuse("meter_errors", subject, `${same.length} event destinations point at ${url}. Delete all but one in Stripe's Dashboard.`);
    else if (!same[0]) create([`thin events: ${events.join(", ")}`]);
    else {
      const destination = same[0];
      if (destination.event_payload !== "thin") {
        if (!options.allowReplace) refuse("meter_errors", subject, `${destination.id} sends ${destination.event_payload} events, and the route reads thin ones. Run with --allow-replace to make a new destination and delete this one; its new secret goes to the Railway file.`);
        else {
          create([`replaces ${destination.id}, which sends ${destination.event_payload} events: thin events, ${events.join(", ")}`]);
          late.push({ object: "meter_errors", action: "delete", subject: `Event destination ${destination.id}`, changes: ["replaced by one that sends thin events"], call: "v2.core.eventDestinations.del", target: destination.id, params: {} });
        }
      } else {
        if (destination.status !== "enabled") steps.push({ object: "meter_errors", action: "update", subject, changes: ["turned off"], call: "v2.core.eventDestinations.enable", target: destination.id, params: {} });
        const missing = events.filter((event) => !destination.enabled_events.includes(event));
        if (missing.length) steps.push({ object: "meter_errors", action: "update", subject, changes: [`add ${missing.join(", ")}`], call: "v2.core.eventDestinations.update", target: destination.id, params: { enabled_events: [...destination.enabled_events, ...missing] } });
      }
    }
  }

  // The packs, after everything else, so the calls before them are the ones a
  // file without packs gets: a product each, found by its pack tag, and its
  // one-time price. The product's key can't be a plan's, since a plan code has no colon.
  for (const desired of catalog.packs) {
    const product = planProduct({ object: "product", name: desired.name, candidates: snapshot.products.filter((entry) => ours(entry.metadata) && entry.metadata[stripeTags.pack] === desired.pack), tags: { ...brandTag, [stripeTags.pack]: desired.pack }, produces: `pack-product:${desired.pack}`, key: `pack:${desired.pack}` });
    if (product === null) continue;
    planPrice({ object: "price", lookupKey: desired.lookupKey, wanted: { product, currency: desired.currency, cents: desired.cents, interval: null, meter: null }, describe: `${money(desired.cents, desired.currency)} once, before tax`, tags: { ...brandTag, [stripeTags.pack]: desired.pack, [stripeTags.terms]: desired.terms }, produces: `pack-price:${desired.pack}` });
  }

  return { steps: [...steps, ...late], refusals };
}

// Links.

/** The deployment-wide objects a Stripe link records in billing_runs.provider_objects. pnpm billing adds the webhook secret's SHA-256. */
export type StripeLinkObjects = {
  meters: Record<OverageKind, string>;
  overage_prices: Record<OverageKind, string>;
  portal_configuration: string;
  webhook_endpoint: string | null;
  meter_error_destination: string | null;
};

/**
 * The link request for a snapshot taken once Stripe sells what the file says:
 * every live price of every sold plan by its lookup key, each plan's coupon,
 * each pack's one-time price, and the deployment-wide objects. missing names
 * what has no single object.
 */
export function stripeLinkBody(input: { catalog: DesiredStripeCatalog; plans: readonly DesiredBillingPlan[]; snapshot: StripeSnapshot }): { plans: BillingCatalogLinkRequest["plans"]; packs: BillingCatalogLinkRequest["packs"]; objects: StripeLinkObjects; missing: string[] } {
  const { catalog, snapshot } = input;
  const missing: string[] = [];
  const livePrice = (lookupKey: string, what: string) => {
    const price = snapshot.prices.find((entry) => entry.lookup_key === lookupKey);
    if (!price?.active) missing.push(`${what}: no live price under ${lookupKey}`);
    return price?.active ? price.id : "";
  };
  const plans: BillingCatalogLinkRequest["plans"] = [];
  for (const plan of input.plans) {
    if (!plan.sold || !plan.prices.length) continue;
    const prices = plan.prices.map((price) => ({ period: price.period, currency: price.currency, provider_ref: livePrice(stripePriceLookupKey(catalog.brand, plan.code, price.period, price.currency, plan.terms_hash), `${plan.code} ${price.period}`) }));
    let discount: string | null = null;
    if (plan.discount) {
      const id = stripeCouponId(catalog.brand, plan.code, plan.terms_hash);
      if (!snapshot.coupons.some((coupon) => coupon.id === id && coupon.valid)) missing.push(`${plan.code} discount: no coupon ${id}`);
      discount = id;
    }
    plans.push({ code: plan.code, terms_hash: plan.terms_hash, provider_disc: discount, prices });
  }
  const packs: BillingCatalogLinkRequest["packs"] = catalog.packs.map((pack) => ({ code: pack.pack, terms_hash: pack.terms, currency: pack.currency, provider_ref: livePrice(pack.lookupKey, `pack ${pack.pack}`) }));
  const meters = {} as Record<OverageKind, string>;
  const overagePrices = {} as Record<OverageKind, string>;
  for (const overage of catalog.overage) {
    const meter = snapshot.meters.filter((entry) => entry.status === "active" && entry.event_name === overage.event);
    if (meter.length !== 1) missing.push(`${overage.kind} meter: ${meter.length} active meters count ${overage.event}`);
    meters[overage.kind] = meter[0]?.id ?? "";
    overagePrices[overage.kind] = livePrice(overage.lookupKey, `${overage.kind} overage`);
  }
  const portals = snapshot.portalConfigurations.filter((configuration) => configuration.active && configuration.metadata[stripeTags.brand] === catalog.brand);
  if (portals.length !== 1) missing.push(`billing portal: ${portals.length} active configurations tagged for ${catalog.brand}`);
  const endpointFor = (url: string | undefined, found: Array<{ id: string; url: string | null }>, what: string) => {
    if (url === undefined) return null;
    const same = found.filter((entry) => entry.url !== null && trimUrl(entry.url) === url);
    if (same.length !== 1) missing.push(`${what}: ${same.length} point at ${url}`);
    return same[0]?.id ?? null;
  };
  return {
    plans,
    packs,
    objects: {
      meters,
      overage_prices: overagePrices,
      portal_configuration: portals[0]?.id ?? "",
      webhook_endpoint: endpointFor(catalog.webhook?.url, snapshot.webhooks, "webhook endpoint"),
      meter_error_destination: endpointFor(catalog.meterErrors?.url, snapshot.eventDestinations, "meter error destination"),
    },
    missing,
  };
}

// Verify.

export type StripeVerifyInput = {
  /** packs: the file's, absent or empty for a file without them. */
  file: { brand: string; hash: string; profile: Pick<BillingProfile, "currency" | "stripe">; plans: readonly DesiredBillingPlan[]; packs?: readonly DesiredBillingPack[] };
  /** getBillingCatalog's answer: the tables, and the deployment's provider settings and latest link. */
  catalog: ApiBillingCatalog;
  /** What the Stripe key read, or why it couldn't. */
  stripe: { env: BillingProviderEnv; snapshot: StripeSnapshot } | { env: BillingProviderEnv; error: string };
  /** The address the webhook endpoint should call. Null skips the webhook, meter error and portal address checks. */
  webhookUrl: string | null;
  links?: { termsUrl: string | null; privacyUrl: string | null };
  /** Only the admin knows its webhook secret, so the worker leaves this check out. */
  checkWebhookSecret: boolean;
  now?: string;
};

const stripeStepCodes: Record<StripeStepObject, BillingCheckCode> = { meter: "meter", overage: "overage", product: "product", price: "price", coupon: "discount", portal: "portal", webhook: "webhook", meter_errors: "webhook" };

const stripeLinkWords = { provider: "Stripe", object: "price", linkOf: (price: { provider_ref: string | null }) => price.provider_ref };

const intervalOf: Record<BillingInterval, "month" | "year"> = { monthly: "month", annual: "year" };

/** Every check of a Stripe deployment, ok ones included. Pure. */
export function verifyStripeCatalog(input: StripeVerifyInput): BillingVerifyResult {
  const { file, catalog } = input;
  const checks: BillingCheckResult[] = [];
  const add: AddBillingCheck = (code, pair, level, subject, message) => checks.push({ code, pair, level, subject, message });

  fileAndPostgresChecks({ file, catalog, ...(input.now ? { now: input.now } : {}) }, add, stripeLinkWords);

  if ("error" in input.stripe) {
    add("unreadable", "file_provider", "drift", "Stripe", input.stripe.error);
    return { status: "failed", checks };
  }
  const { snapshot } = input.stripe;

  // File and Stripe: everything an apply would still change.
  const desired = desiredStripeCatalog({ brand: file.brand, profile: file.profile, plans: file.plans, ...(file.packs ? { packs: file.packs } : {}), webhookUrl: input.webhookUrl, ...(input.links ? { links: input.links } : {}) });
  const plan = planStripeChanges({ catalog: desired, snapshot, options: { adopt: false, allowReplace: true, allowArchive: true } });
  const found = new Set<BillingCheckCode>();
  for (const step of plan.steps) {
    const code = step.leftover ? "leftover" : stripeStepCodes[step.object];
    found.add(code);
    add(code, "file_provider", "drift", step.subject, `${step.subject}: ${step.changes.join("; ") || step.action}.`);
  }
  for (const refusal of plan.refusals) {
    found.add(stripeStepCodes[refusal.object]);
    add(stripeStepCodes[refusal.object], "file_provider", "drift", refusal.subject, `${refusal.subject}: ${refusal.message}`);
  }
  // Packs are named only when the file has some, so a file without them reads as before.
  const packs = desired.packs.length;
  const okLines: Array<[BillingCheckCode, string]> = [
    ["meter", `${desired.overage.length} meters, each summing dollars of overage`],
    ["overage", `${desired.overage.length} overage prices at ${money(STRIPE_OVERAGE_UNIT_CENTS, desired.currency)} a dollar of usage`],
    ["product", `${desired.products.length} products${packs ? ` and ${packs} pack ${packs === 1 ? "product" : "products"}` : ""}, tagged and taxed as ${desired.taxCode}`],
    ["price", `${desired.prices.length} prices${packs ? ` and ${packs} one-time pack ${packs === 1 ? "price" : "prices"}` : ""} before tax, each under its lookup key`],
    ["discount", desired.coupons.length ? `${desired.coupons.length} ${desired.coupons.length === 1 ? "coupon" : "coupons"}` : "no coupons"],
    ["portal", `billing portal with plan changes ${desired.portal.planChanges ? "on" : "off"} and cancelling ${desired.portal.cancel ? "on" : "off"}`],
    ...(desired.webhook ? [["webhook", `webhook ${desired.webhook.url}, ${desired.webhook.events.length} events, API version ${STRIPE_API_VERSION}, and the meter error destination`] as [BillingCheckCode, string]] : []),
    ["leftover", `nothing else tagged for ${file.brand}`],
  ];
  for (const [code, message] of okLines) if (!found.has(code)) add(code, "file_provider", "ok", code, message);

  // Stripe Tax: Stripe computes the tax only where the account is registered. A sandbox only warns.
  const taxLevel = snapshot.mode === "live" ? "drift" : "warn";
  if (desired.managedPayments) add("tax", "file_provider", "ok", "tax", "Managed Payments: Stripe is the merchant of record and handles the tax");
  else if (!snapshot.tax) add("tax", "file_provider", "warn", "tax", "The key can't read Stripe Tax's settings, so they weren't checked.");
  else {
    const problems = [
      ...(snapshot.tax.status !== "active" ? ["Stripe Tax isn't active"] : []),
      ...(!snapshot.tax.headOffice ? ["it has no origin address"] : []),
      ...(snapshot.tax.registrations === 0 ? ["it has no tax registration, so it collects no tax"] : []),
    ];
    if (problems.length) add("tax", "file_provider", taxLevel, "tax", `${problems.join("; ")}. Set it up in Stripe's Dashboard (Tax).`);
    else add("tax", "file_provider", "ok", "tax", `Stripe Tax active, with ${snapshot.tax.registrations} ${snapshot.tax.registrations === 1 ? "registration" : "registrations"}`);
  }

  // Postgres and Stripe.
  const prices = new Map(snapshot.prices.map((price) => [price.id, price]));
  const products = new Map(snapshot.products.map((product) => [product.id, product]));
  let linked = 0;
  let badLinks = 0;
  for (const row of catalog.plans.filter((entry) => entry.status !== "retired")) {
    for (const price of row.prices.filter((entry) => entry.retired_at === null && entry.provider_ref !== null)) {
      linked += 1;
      const subject = `${row.code}/${price.period}`;
      const found = prices.get(price.provider_ref!);
      const product = found ? products.get(found.product) : undefined;
      const problem = !found ? "isn't in this Stripe account"
        : !found.active ? "is archived"
        : product?.metadata[stripeTags.brand] !== file.brand || product.metadata[stripeTags.plan] !== row.code ? `belongs to product ${found.product}, which isn't tagged ${file.brand} ${row.code}`
        : found.unit_amount !== price.cents || found.currency !== price.currency || found.recurring?.interval !== intervalOf[price.period] ? `doesn't sell ${money(price.cents, price.currency)} a ${intervalOf[price.period]}`
        : null;
      if (problem) {
        badLinks += 1;
        add("linked_id", "postgres_provider", "drift", subject, `${subject} is linked to price ${price.provider_ref}, which ${problem}.`);
      }
    }
  }
  // A pack's price is one-time, on a product tagged with the pack. An instance older than packs answers without them.
  const packRows = catalog.packs ?? [];
  let packsLinked = 0;
  for (const row of packRows.filter((entry) => entry.status !== "retired")) {
    for (const price of row.prices.filter((entry) => entry.retired_at === null && entry.provider_ref !== null)) {
      packsLinked += 1;
      const subject = `${row.code}/${price.currency}`;
      const found = prices.get(price.provider_ref!);
      const product = found ? products.get(found.product) : undefined;
      const problem = !found ? "isn't in this Stripe account"
        : !found.active ? "is archived"
        : product?.metadata[stripeTags.brand] !== file.brand || product.metadata[stripeTags.pack] !== row.code ? `belongs to product ${found.product}, which isn't tagged ${file.brand} pack ${row.code}`
        : found.recurring !== null ? `bills every ${found.recurring.interval_count} ${found.recurring.interval}, while a pack is paid once`
        : found.unit_amount !== price.cents || found.currency !== price.currency ? `doesn't sell ${money(price.cents, price.currency)} once`
        : null;
      if (problem) {
        badLinks += 1;
        add("linked_id", "postgres_provider", "drift", subject, `Pack ${subject} is linked to price ${price.provider_ref}, which ${problem}.`);
      }
    }
  }
  if (!badLinks) add("linked_id", "postgres_provider", "ok", "links", `${linked} prices${packs ? ` and ${packsLinked} pack ${packsLinked === 1 ? "price" : "prices"}` : ""} linked, all live and priced as the rows say`);
  for (const row of catalog.plans) {
    for (const price of row.prices.filter((entry) => entry.retired_at !== null && entry.provider_ref !== null)) {
      if (!prices.has(price.provider_ref!)) add("retired_id", "postgres_provider", "info", `${row.code}/${price.period}`, `The retired ${row.code} ${price.period} price ${price.provider_ref} isn't in Stripe any more.`);
    }
  }
  for (const row of packRows) {
    for (const price of row.prices.filter((entry) => entry.retired_at !== null && entry.provider_ref !== null)) {
      if (!prices.has(price.provider_ref!)) add("retired_id", "postgres_provider", "info", `${row.code}/${price.currency}`, `The retired pack ${row.code} ${price.currency} price ${price.provider_ref} isn't in Stripe any more.`);
    }
  }

  // The account and the key's mode against the instance and its latest link.
  const instance = catalog.provider;
  const lastLink = instance.last_link;
  const accountProblems = [
    ...(instance.account === null ? ["STRIPE_ACCOUNT_ID isn't set on the instance"] : instance.account !== snapshot.account.id ? [`the instance uses Stripe account ${instance.account} and the key reaches ${snapshot.account.id}`] : []),
    ...(lastLink && lastLink.provider_account !== snapshot.account.id ? [`the last link went to Stripe account ${String(lastLink.provider_account)}`] : []),
  ];
  if (accountProblems.length) add("account", "postgres_provider", "drift", "account", `${accountProblems.join("; ")}.`);
  else add("account", "postgres_provider", "ok", "account", `Stripe account ${snapshot.account.name ?? snapshot.account.id}`);
  const modeProblems = [
    ...(snapshot.mode !== input.stripe.env ? [`the key is a ${snapshot.mode === "live" ? "live" : "test"} key, and the run asked for ${input.stripe.env}`] : []),
    ...(instance.env !== snapshot.mode ? [`the instance bills ${instance.env === "live" ? "live" : "in a sandbox"}`] : []),
    ...(lastLink && lastLink.provider_env !== snapshot.mode ? [`the last link went to ${String(lastLink.provider_env)}`] : []),
  ];
  if (modeProblems.length) add("mode", "postgres_provider", "drift", "mode", `The key is ${snapshot.mode === "live" ? "live" : "a test key"}, but ${modeProblems.join("; ")}.`);
  else add("mode", "postgres_provider", "ok", "mode", snapshot.mode === "live" ? "a live key on a live deployment" : "a test key on a sandbox deployment");

  // What the latest link recorded beyond plans and prices, which the worker and the portal sessions read.
  const objects = (instance.objects ?? {}) as Partial<StripeLinkObjects> & { webhook_secret_sha256?: string | null };
  if (lastLink) {
    const body = stripeLinkBody({ catalog: desired, plans: file.plans, snapshot });
    const stale = desired.overage.filter((overage) => body.objects.overage_prices[overage.kind] && objects.overage_prices?.[overage.kind] !== body.objects.overage_prices[overage.kind]).map((overage) => `${overage.kind} overage price ${objects.overage_prices?.[overage.kind] ?? "none"}, Stripe's is ${body.objects.overage_prices[overage.kind]}`);
    if (stale.length) add("overage", "postgres_provider", "drift", "overage", `The latest link recorded ${stale.join("; ")}. Run pnpm billing apply.`);
    else add("overage", "postgres_provider", "ok", "overage", "the latest link records Stripe's overage prices");
    const portal = body.objects.portal_configuration;
    if (portal && objects.portal_configuration !== portal) add("portal", "postgres_provider", "drift", "portal", `The latest link recorded billing portal ${objects.portal_configuration ?? "none"}, Stripe's is ${portal}. Run pnpm billing apply.`);
    else add("portal", "postgres_provider", "ok", "portal", "the latest link records the billing portal's configuration");
  }
  if (input.checkWebhookSecret && desired.webhook) {
    if (!instance.secret_sha256) add("webhook_secret", "postgres_provider", "drift", "webhook", "STRIPE_WEBHOOK_SECRET isn't set on the instance, so it refuses every Stripe event.");
    else if (!objects.webhook_secret_sha256) add("webhook_secret", "postgres_provider", "warn", "webhook", "The latest link recorded no webhook secret, so the instance's can't be compared: Stripe never shows it again.");
    else if (objects.webhook_secret_sha256 !== instance.secret_sha256) add("webhook_secret", "postgres_provider", "drift", "webhook", "The instance's STRIPE_WEBHOOK_SECRET isn't the one the endpoint was made with, so it refuses every Stripe event. Set the secret from the Railway file pnpm billing wrote.");
    else add("webhook_secret", "postgres_provider", "ok", "webhook", "the instance's webhook secret is the endpoint's");
  }

  return { status: checks.some((check) => check.level === "drift") ? "drift" : "passed", checks };
}

/** Stripe's planner, which pnpm billing and the daily check run from step 11 of the Stripe plan. */
export const stripePlanner: CatalogPlanner<DesiredStripeCatalog, StripeSnapshot, StripeStep, StripeVerifyInput, StripeRefusal> = {
  provider: "stripe",
  desired: (input) => desiredStripeCatalog(input),
  plan: (input) => planStripeChanges({ catalog: input.desired, snapshot: input.snapshot, options: input.options }),
  verify: (input) => verifyStripeCatalog(input),
  linkBody: (input) => stripeLinkBody({ catalog: input.desired, plans: input.plans, snapshot: input.snapshot }),
};
