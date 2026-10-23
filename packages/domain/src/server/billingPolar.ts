import type { PolarCredits, PolarDiscount, PolarMeter, PolarMetadata, PolarPrice, PolarProduct, PolarSnapshot } from "@lobbystack/providers";
import { billingMeterEventNames, trimTrailingSlashes, type ApiBillingCatalogLink, type BillingInterval, type BillingProfile, type ResolvedBillingDiscount } from "@lobbystack/shared";

import type { DesiredBillingPlan } from "./billingCatalog";

// What a billing.json makes Polar sell, and the calls that get it there. Every
// Polar object made here carries metadata naming the row it came from, so a
// rerun finds what an interrupted run made instead of making it again, and
// another brand's objects are never touched. Pure: the plan is computed from
// a snapshot of the organization, so the rules are tested without Polar, and
// `pnpm billing` and the worker's daily check read the same plan.

/** The 15 events LobbyStack's Polar webhook handles. */
export const POLAR_WEBHOOK_EVENTS = [
  "subscription.created",
  "subscription.active",
  "subscription.updated",
  "subscription.canceled",
  "subscription.uncanceled",
  "subscription.revoked",
  "subscription.past_due",
  "subscription.cycled",
  "subscription.paused",
  "subscription.resumed",
  "subscription.migrated",
  "order.created",
  "order.updated",
  "order.paid",
  "order.refunded",
] as const;

/** The path under the dashboard's address that Polar's webhook calls. */
export const POLAR_WEBHOOK_PATH = "/api/webhooks/polar";

/** The metadata keys LobbyStack writes on Polar objects. */
export const polarTags = {
  brand: "lobbystack_brand",
  plan: "lobbystack_plan",
  interval: "lobbystack_interval",
  terms: "lobbystack_terms",
  meter: "lobbystack_meter",
  key: "lobbystack_key",
} as const;

type MeterSource = Pick<DesiredBillingPlan, "voice_sec" | "sms_seg" | "calls_out" | "voice_rate" | "sms_rate" | "call_rate">;

/** The usage Polar bills past a plan's allowance, with the names polar-setup.mjs gave its meters and Credits. */
export const polarMeterSpecs = [
  { key: "voice_minutes", name: "Voice minutes", event: billingMeterEventNames.voiceMinutes, noun: "voice minutes", units: (plan: MeterSource) => Math.floor((plan.voice_sec ?? 0) / 60), rate: (plan: MeterSource) => plan.voice_rate ?? 0 },
  { key: "alert_sms_segments", name: "Alert SMS segments", event: billingMeterEventNames.alertSmsSegments, noun: "alert SMS segments", units: (plan: MeterSource) => plan.sms_seg ?? 0, rate: (plan: MeterSource) => plan.sms_rate ?? 0 },
  { key: "outbound_call_attempts", name: "Call transfers", event: billingMeterEventNames.outboundCallAttempts, noun: "call transfers", units: (plan: MeterSource) => plan.calls_out ?? 0, rate: (plan: MeterSource) => plan.call_rate ?? 0 },
] as const;

export type PolarMeterKey = (typeof polarMeterSpecs)[number]["key"];

export type DesiredPolarMeter = { key: PolarMeterKey; name: string; event: string };
export type DesiredPolarCredits = { key: string; plan: string; meter: PolarMeterKey; units: number; description: string };
export type DesiredPolarProduct = {
  plan: string;
  period: BillingInterval;
  name: string;
  interval: "month" | "year";
  cents: number;
  currency: string;
  rates: Record<PolarMeterKey, number>;
  visibility: "public" | "private";
  terms: string;
  /** The keys of the Credits it carries: a monthly product's, never an annual one's. */
  credits: string[];
};
export type DesiredPolarDiscount = { plan: string; name: string; terms: string; currency: string; discount: ResolvedBillingDiscount; products: string[] };

/** Everything one brand's file makes Polar sell. */
export type DesiredPolarCatalog = {
  brand: string;
  currency: string;
  settings: { allowMultipleSubscriptions: boolean; portalPlanChanges: boolean };
  meters: DesiredPolarMeter[];
  credits: DesiredPolarCredits[];
  products: DesiredPolarProduct[];
  discounts: DesiredPolarDiscount[];
  /** Null when the instance's address isn't known, as on a worker without APP_BASE_URL: the webhook is then neither set up nor checked. */
  webhook: { url: string; events: string[] } | null;
};

const standardLabels: Record<string, string> = { starter: "Starter", pro: "Pro" };
const periodWords: Record<BillingInterval, string> = { monthly: "monthly", annual: "annual" };

/** "starter/monthly": how a product is named among the plan's prices. */
export const productKey = (plan: string, period: string) => `${plan}/${period}`;

function planLabel(plan: DesiredBillingPlan): string {
  // Own keys only: a plan coded constructor isn't Object's.
  return (Object.hasOwn(standardLabels, plan.code) ? standardLabels[plan.code] : undefined) ?? plan.names?.en ?? plan.code;
}

/**
 * The Polar objects a checked file needs: a meter per usage kind, a product
 * per live price of every sold plan, Credits for each monthly product's
 * allowances, a discount per plan that has one, and the webhook. Annual
 * products get no Credits: the worker reports only each month's overage for
 * them, so Credits would take the allowance off twice. A plan sold only by
 * the year has none at all.
 */
export function desiredPolarCatalog(input: { brand: string; profile: Pick<BillingProfile, "currency" | "polar">; plans: readonly DesiredBillingPlan[]; webhookUrl: string | null }): DesiredPolarCatalog {
  const credits: DesiredPolarCredits[] = [];
  const products: DesiredPolarProduct[] = [];
  const discounts: DesiredPolarDiscount[] = [];
  for (const plan of input.plans) {
    if (!plan.sold || !plan.prices.length) continue;
    const label = planLabel(plan);
    const sellsMonthly = plan.prices.some((price) => price.period === "monthly");
    const planCredits = !sellsMonthly ? [] : polarMeterSpecs.flatMap((meter) => {
      const units = meter.units(plan);
      // Polar refuses Credits of 0 units, so a plan that includes none of a meter gets none.
      return units > 0 ? [{ key: `${input.brand}/${plan.code}/${meter.key}`, plan: plan.code, meter: meter.key, units, description: `${units} ${meter.noun} a month` }] : [];
    });
    credits.push(...planCredits);
    for (const price of plan.prices) {
      products.push({
        plan: plan.code,
        period: price.period,
        name: `${label} ${periodWords[price.period]}`,
        interval: price.period === "annual" ? "year" : "month",
        cents: price.cents,
        currency: price.currency,
        rates: Object.fromEntries(polarMeterSpecs.map((meter) => [meter.key, meter.rate(plan)])) as Record<PolarMeterKey, number>,
        visibility: plan.access === "public" ? "public" : "private",
        terms: plan.terms_hash,
        credits: price.period === "monthly" ? planCredits.map((entry) => entry.key) : [],
      });
    }
    if (plan.discount) discounts.push({ plan: plan.code, name: `${label} discount`, terms: plan.terms_hash, currency: input.profile.currency, discount: plan.discount, products: plan.prices.map((price) => productKey(plan.code, price.period)) });
  }
  return {
    brand: input.brand,
    currency: input.profile.currency,
    settings: { allowMultipleSubscriptions: input.profile.polar.allowMultipleSubscriptions, portalPlanChanges: input.profile.polar.portalPlanChanges },
    meters: polarMeterSpecs.map((meter) => ({ key: meter.key, name: meter.name, event: meter.event })),
    credits,
    products,
    discounts,
    webhook: input.webhookUrl ? { url: input.webhookUrl, events: [...POLAR_WEBHOOK_EVENTS] } : null,
  };
}

// The plan of Polar calls.

export type PolarStepObject = "organization" | "meter" | "credits" | "product" | "discount" | "webhook";
/** tag: an object polar-setup.mjs made, taken over by --adopt. attach: a product's Credits. end: a discount ended now. */
export type PolarStepAction = "create" | "update" | "tag" | "attach" | "archive" | "end";

/** An object made earlier in the same run, named until Polar gives it an id. */
export type PolarRef = { $ref: string };

export type PolarStep = {
  object: PolarStepObject;
  action: PolarStepAction;
  subject: string;
  /** What the call changes, one line each, as people read it. */
  changes: string[];
  /** It archives or ends an object tagged for this brand that the file no longer names. */
  leftover?: boolean;
  method: "POST" | "PATCH";
  /** A {{ref}} in it is an object made earlier in the run. */
  path: string;
  body: unknown;
  /** The ref the created object's id answers to. */
  produces?: string;
};

export type PolarRefusal = { object: PolarStepObject; subject: string; message: string };

export type PolarPlanOptions = {
  /** Take over untagged objects polar-setup.mjs made, by tagging them. */
  adopt: boolean;
  /** Make a new object where Polar never changes the old one: a product's billing cycle, a locked meter, a redeemed discount. */
  allowReplace: boolean;
  /** Archive a product, or end a discount, that the file no longer sells. */
  allowArchive: boolean;
  /** Lower Credits, which reach current subscribers at once. */
  allowLess: boolean;
};

export type PolarPlan = { steps: PolarStep[]; refusals: PolarRefusal[] };

const ref = (name: string): PolarRef => ({ $ref: name });
const isRef = (value: unknown): value is PolarRef => Boolean(value && typeof value === "object" && "$ref" in value);
const idText = (value: string | PolarRef) => (isRef(value) ? `{{${value.$ref}}}` : value);

function money(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

function quoted(items: ReadonlyArray<{ name?: string; description?: string; id: string }>): string {
  return items.map((item) => `"${item.name ?? item.description ?? item.id}"`).join(", ");
}

/** The metadata to send: Polar replaces the whole map on update, so every key already there is kept. Null when the tags already match. */
function mergedTags(existing: PolarMetadata, tags: Record<string, string>): PolarMetadata | null {
  if (Object.entries(tags).every(([key, value]) => existing[key] === value)) return null;
  return { ...existing, ...tags };
}

type Clause = { property?: unknown; operator?: unknown; value?: unknown };

function clausesOf(filter: unknown): Clause[] {
  if (!filter || typeof filter !== "object") return [];
  const clauses = (filter as { clauses?: unknown }).clauses;
  if (Array.isArray(clauses)) return clauses.flatMap(clausesOf);
  return [filter as Clause];
}

function countsEvent(meter: PolarMeter, event: string): boolean {
  return clausesOf(meter.filter).some((clause) => clause.property === "name" && clause.value === event);
}

/** One clause, Name equals the event, and Sum of quantity: what LobbyStack's usage reports need. */
function meterMatches(meter: PolarMeter, event: string): boolean {
  const clauses = clausesOf(meter.filter);
  const aggregation = meter.aggregation as { func?: unknown; property?: unknown } | null;
  return clauses.length === 1 && clauses[0]!.property === "name" && clauses[0]!.operator === "eq" && clauses[0]!.value === event && aggregation?.func === "sum" && (aggregation.property === "quantity" || aggregation.property === "metadata.quantity");
}

function livePrices(product: PolarProduct): PolarPrice[] {
  // Ad hoc prices belong to one checkout, not to what the product sells.
  return product.prices.filter((price) => !price.is_archived && price.source !== "ad_hoc");
}

function inCurrency(price: PolarPrice, currency: string): boolean {
  return String(price.price_currency ?? "").toLowerCase() === currency;
}

type DesiredPrice = { body: Record<string, unknown>; describe: string; matches(price: PolarPrice): boolean };

function desiredPrices(product: DesiredPolarProduct, meterIds: ReadonlyMap<PolarMeterKey, string | PolarRef>): DesiredPrice[] {
  const per = product.interval === "year" ? "a year" : "a month";
  return [
    {
      body: { amount_type: "fixed", price_amount: product.cents, price_currency: product.currency },
      describe: `${money(product.cents, product.currency)} ${per}`,
      matches: (price) => price.amount_type === "fixed" && inCurrency(price, product.currency) && price.price_amount === product.cents,
    },
    ...polarMeterSpecs.map((meter) => {
      const meterId = meterIds.get(meter.key)!;
      const rate = product.rates[meter.key];
      return {
        body: { amount_type: "metered_unit", meter_id: meterId, unit_amount: String(rate), price_currency: product.currency },
        describe: `${meter.name} at ${money(rate, product.currency)} each`,
        matches: (price: PolarPrice) => price.amount_type === "metered_unit" && inCurrency(price, product.currency) && !isRef(meterId) && price.meter_id === meterId && Number(price.unit_amount) === rate,
      };
    }),
  ];
}

function describePrice(price: PolarPrice, meters: readonly PolarMeter[]): string {
  if (price.amount_type === "fixed") return `${money(Number(price.price_amount ?? 0), price.price_currency)} fixed`;
  if (price.amount_type === "metered_unit") return `${meters.find((meter) => meter.id === price.meter_id)?.name ?? "a meter"} at ${money(Number(price.unit_amount ?? 0), price.price_currency)} each`;
  return `a ${price.amount_type} price`;
}

function newestFirst(a: PolarProduct, b: PolarProduct): number {
  const time = (product: PolarProduct) => product.modified_at ?? product.created_at ?? "";
  return time(a) < time(b) ? 1 : time(a) > time(b) ? -1 : 0;
}

const trimSlash = (url: string) => trimTrailingSlashes(url.trim());

function discountLive(discount: PolarDiscount, now: string): boolean {
  return discount.ends_at === null || new Date(discount.ends_at).getTime() > new Date(now).getTime();
}

function discountAmountText(discount: ResolvedBillingDiscount, currency: string): string {
  const off = discount.type === "percentage" ? `${(discount.basis_points ?? 0) / 100}% off` : `${money(discount.amount_cents ?? 0, currency)} off`;
  return `${off}, ${discount.duration === "repeating" ? `for ${discount.duration_in_months} months` : discount.duration}`;
}

type ProductMatch = {
  desired: DesiredPolarProduct;
  /** The live or archived product that sells this row now; absent when one is made. */
  found?: PolarProduct;
  adopting: boolean;
  restoring: boolean;
  /** A product whose billing cycle can't become the file's, archived once its replacement exists. */
  replaced?: PolarProduct;
};

/**
 * The calls that make an organization sell what the file says, in the order
 * they run: settings, meters, Credits, products, their Credits, discounts,
 * the webhook, then archiving, meters last. Anything the run must not decide
 * on its own is a refusal instead, and a run with refusals makes no call at all.
 */
export function planPolarChanges(input: { catalog: DesiredPolarCatalog; snapshot: PolarSnapshot; options: PolarPlanOptions; now?: string }): PolarPlan {
  const { catalog, snapshot, options } = input;
  const now = input.now ?? new Date().toISOString();
  const steps: PolarStep[] = [];
  const late: PolarStep[] = [];
  // Polar refuses to archive a meter that a live product's price still uses, so meters wait for the products.
  const lateMeters: PolarStep[] = [];
  const refusals: PolarRefusal[] = [];
  const refuse = (object: PolarStepObject, subject: string, message: string) => refusals.push({ object, subject, message });
  const ours = (metadata: PolarMetadata) => metadata[polarTags.brand] === catalog.brand;
  const tagged = (metadata: PolarMetadata) => metadata[polarTags.brand] !== undefined;

  // The organization's settings. Polar wants a product priced in the default currency, so this goes first.
  const organization = snapshot.organization;
  const orgBody: Record<string, unknown> = {};
  const orgChanges: string[] = [];
  const defaultCurrency = String(organization.default_presentment_currency ?? "usd").toLowerCase();
  if (defaultCurrency !== catalog.currency) {
    const blocking = snapshot.products.filter((product) => !product.is_archived && !livePrices(product).some((price) => inCurrency(price, catalog.currency)));
    if (blocking.length) refuse("organization", organization.name, `Polar won't make ${catalog.currency.toUpperCase()} the default currency while ${quoted(blocking)} ${blocking.length === 1 ? "has" : "have"} no ${catalog.currency.toUpperCase()} price. Give them one or archive them in Polar, or keep ${defaultCurrency} in billing.json.`);
    else {
      orgBody.default_presentment_currency = catalog.currency;
      orgChanges.push(`default currency ${defaultCurrency.toUpperCase()}, the file says ${catalog.currency.toUpperCase()}`);
    }
  }
  const subscriptionSettings = organization.subscription_settings ?? {};
  if (Boolean(subscriptionSettings.allow_multiple_subscriptions) !== catalog.settings.allowMultipleSubscriptions) {
    orgBody.subscription_settings = { ...subscriptionSettings, allow_multiple_subscriptions: catalog.settings.allowMultipleSubscriptions };
    orgChanges.push(catalog.settings.allowMultipleSubscriptions ? "allow several subscriptions per customer" : "allow one subscription per customer");
  }
  const portal = organization.customer_portal_settings ?? {};
  const portalSubscription = (portal.subscription ?? {}) as Record<string, unknown>;
  if (Boolean(portalSubscription.update_plan) !== catalog.settings.portalPlanChanges) {
    orgBody.customer_portal_settings = { ...portal, subscription: { ...portalSubscription, update_plan: catalog.settings.portalPlanChanges } };
    orgChanges.push(catalog.settings.portalPlanChanges ? "turn on plan changes in the customer portal" : "turn off plan changes in the customer portal");
  }
  if (orgChanges.length) steps.push({ object: "organization", action: "update", subject: organization.name, changes: orgChanges, method: "PATCH", path: `/v1/organizations/${organization.id}`, body: orgBody });

  // Meters: found by tag; one polar-setup.mjs made is adopted by its event filter.
  const meterIds = new Map<PolarMeterKey, string | PolarRef>();
  const liveMeters = snapshot.meters.filter((meter) => meter.archived_at === null);
  for (const meter of catalog.meters) {
    const subject = `Meter "${meter.name}"`;
    const create = (changes: string[]) => {
      steps.push({ object: "meter", action: "create", subject, changes, method: "POST", path: "/v1/meters/", body: { name: meter.name, filter: { conjunction: "and", clauses: [{ property: "name", operator: "eq", value: meter.event }] }, aggregation: { func: "sum", property: "quantity" }, metadata: { [polarTags.meter]: meter.key } }, produces: `meter:${meter.key}` });
      meterIds.set(meter.key, ref(`meter:${meter.key}`));
    };
    const withTag = liveMeters.filter((candidate) => candidate.metadata[polarTags.meter] === meter.key);
    if (withTag.length > 1) {
      refuse("meter", subject, `${withTag.length} live meters are tagged ${meter.key} (${quoted(withTag)}). Archive all but one in Polar.`);
      continue;
    }
    let found = withTag[0];
    let adopting = false;
    if (!found) {
      const lookalikes = liveMeters.filter((candidate) => candidate.metadata[polarTags.meter] === undefined && countsEvent(candidate, meter.event));
      if (lookalikes.length && !options.adopt) {
        refuse("meter", subject, `${quoted(lookalikes)} counts ${meter.event} but has no LobbyStack tag. Run with --adopt to take it over, or archive it in Polar.`);
        continue;
      }
      if (lookalikes.length > 1) {
        refuse("meter", subject, `${lookalikes.length} meters count ${meter.event} (${quoted(lookalikes)}). Archive all but one in Polar.`);
        continue;
      }
      found = lookalikes[0];
      adopting = found !== undefined;
    }
    if (!found) {
      create([`Sum of quantity where Name equals ${meter.event}`]);
      continue;
    }
    if (!meterMatches(found, meter.event)) {
      // Polar locks a meter's filter and aggregation once it has counted an event.
      if (!options.allowReplace) {
        refuse("meter", subject, `"${found.name}" isn't Sum of quantity where Name equals ${meter.event}, and Polar locks that once a meter counts an event. Run with --allow-replace to make a new meter and archive this one.`);
        continue;
      }
      create([`replaces "${found.name}", which doesn't count Sum of quantity where Name equals ${meter.event}`]);
      lateMeters.push({ object: "meter", action: "archive", subject: `Meter "${found.name}"`, changes: [`replaced by a new "${meter.name}"`], method: "PATCH", path: `/v1/meters/${found.id}`, body: { is_archived: true } });
      continue;
    }
    const body: Record<string, unknown> = {};
    const changes: string[] = adopting ? ["tag it as LobbyStack's"] : [];
    if (found.name !== meter.name) {
      body.name = meter.name;
      changes.push(`name "${found.name}", the file says "${meter.name}"`);
    }
    const metadata = mergedTags(found.metadata, { [polarTags.meter]: meter.key });
    if (metadata) {
      body.metadata = metadata;
      if (!adopting) changes.push("tag it as LobbyStack's");
    }
    if (Object.keys(body).length) steps.push({ object: "meter", action: adopting ? "tag" : "update", subject, changes, method: "PATCH", path: `/v1/meters/${found.id}`, body });
    meterIds.set(meter.key, found.id);
  }

  // Products, matched before Credits: adopting Credits needs the plan's monthly product.
  const matches: ProductMatch[] = [];
  for (const desired of catalog.products) {
    const subject = `Product "${desired.name}"`;
    const rowProducts = snapshot.products.filter((product) => ours(product.metadata) && product.metadata[polarTags.plan] === desired.plan && product.metadata[polarTags.interval] === desired.period);
    const live = rowProducts.filter((product) => !product.is_archived);
    if (live.length > 1) {
      refuse("product", subject, `${live.length} live products are tagged ${catalog.brand} ${desired.plan} ${desired.period} (${quoted(live)}). Archive all but one in Polar.`);
      continue;
    }
    const match: ProductMatch = { desired, adopting: false, restoring: false };
    if (live[0]) match.found = live[0];
    else {
      const named = snapshot.products.filter((product) => !product.is_archived && product.name === desired.name);
      const foreign = named.filter((product) => tagged(product.metadata) && !ours(product.metadata));
      if (foreign.length) {
        refuse("product", subject, `${quoted(foreign)} is tagged for ${String(foreign[0]!.metadata[polarTags.brand])}, so this organization sells another brand. Use a Polar organization of ${catalog.brand}'s own.`);
        continue;
      }
      const lookalikes = named.filter((product) => !tagged(product.metadata));
      if (lookalikes.length && !options.adopt) {
        refuse("product", subject, `${quoted(lookalikes)} has no LobbyStack tag. Run with --adopt to take it over, or archive it in Polar.`);
        continue;
      }
      if (lookalikes.length > 1) {
        refuse("product", subject, `${lookalikes.length} live products are named "${desired.name}". Archive all but one in Polar.`);
        continue;
      }
      if (lookalikes[0]) {
        match.found = lookalikes[0];
        match.adopting = true;
      } else {
        // A period back in the file brings back the product its row kept.
        const [archived] = rowProducts.filter((product) => product.is_archived).sort(newestFirst);
        if (archived) {
          match.found = archived;
          match.restoring = true;
        }
      }
    }
    if (match.found && (match.found.recurring_interval !== desired.interval || (match.found.recurring_interval_count ?? 1) !== 1)) {
      // Polar never changes a product's billing cycle.
      if (!options.allowReplace) {
        refuse("product", subject, `"${match.found.name}" bills every ${match.found.recurring_interval_count ?? 1} ${match.found.recurring_interval ?? "once"}, and Polar never changes a product's billing cycle. Run with --allow-replace to make a new product and archive this one; its subscribers keep it.`);
        continue;
      }
      if (!match.found.is_archived) match.replaced = match.found;
      delete match.found;
      match.adopting = false;
      match.restoring = false;
    }
    matches.push(match);
  }
  const matchFor = (plan: string, period: string) => matches.find((match) => match.desired.plan === plan && match.desired.period === period);

  // Credits: found by tag; one polar-setup.mjs made is adopted by meter and units on the plan's monthly product.
  const creditIds = new Map<string, string | PolarRef>();
  for (const credits of catalog.credits) {
    const meterSpec = polarMeterSpecs.find((meter) => meter.key === credits.meter)!;
    const subject = `Credits "${credits.description}" for ${credits.plan}`;
    const meterId = meterIds.get(credits.meter);
    if (meterId === undefined) continue;
    const withTag = snapshot.credits.filter((benefit) => ours(benefit.metadata) && benefit.metadata[polarTags.key] === credits.key);
    if (withTag.length > 1) {
      refuse("credits", subject, `${withTag.length} Credits are tagged ${credits.key} (${quoted(withTag)}). Detach all but one in Polar.`);
      continue;
    }
    let found: PolarCredits | undefined = withTag[0];
    let adopting = false;
    if (!found) {
      const monthly = matchFor(credits.plan, "monthly")?.found;
      const attached = new Set((monthly?.benefits ?? []).map((benefit) => benefit.id));
      const lookalikes = snapshot.credits.filter((benefit) => !tagged(benefit.metadata) && attached.has(benefit.id) && benefit.properties.meter_id === meterId);
      if (lookalikes.length && !options.adopt) {
        refuse("credits", subject, `${quoted(lookalikes)} on "${monthly!.name}" has no LobbyStack tag. Run with --adopt to take it over, or detach it in Polar.`);
        continue;
      }
      const same = lookalikes.filter((benefit) => benefit.properties.units === credits.units);
      if (same.length > 1) {
        refuse("credits", subject, `${same.length} Credits on "${monthly!.name}" give ${credits.units} ${meterSpec.noun} (${quoted(same)}). Detach all but one in Polar.`);
        continue;
      }
      found = same[0];
      adopting = found !== undefined;
    }
    const properties = { units: credits.units, rollover: false, meter_id: meterId };
    if (!found) {
      steps.push({ object: "credits", action: "create", subject, changes: [`${credits.units} ${meterSpec.noun} a month, no rollover`], method: "POST", path: "/v1/benefits/", body: { type: "meter_credit", description: credits.description, properties, metadata: { [polarTags.brand]: catalog.brand, [polarTags.key]: credits.key } }, produces: `credits:${credits.key}` });
      creditIds.set(credits.key, ref(`credits:${credits.key}`));
      continue;
    }
    creditIds.set(credits.key, found.id);
    const changes: string[] = adopting ? ["tag it as LobbyStack's"] : [];
    const body: Record<string, unknown> = { type: "meter_credit" };
    if (found.properties.units !== credits.units) {
      if (credits.units < found.properties.units && !options.allowLess) {
        refuse("credits", subject, `Polar gives ${found.properties.units} ${meterSpec.noun} and the file says ${credits.units}. Fewer Credits reach current subscribers at once: run with --allow-less to lower them.`);
        continue;
      }
      changes.push(`${found.properties.units} ${meterSpec.noun}, the file says ${credits.units}`);
    }
    if (found.properties.rollover) changes.push("rolls unused units over, the file says it doesn't");
    if (found.properties.meter_id !== meterId) changes.push(`counts another meter, the file says "${meterSpec.name}"`);
    if (found.properties.units !== credits.units || found.properties.rollover || found.properties.meter_id !== meterId) body.properties = properties;
    if (found.description !== credits.description) {
      body.description = credits.description;
      changes.push(`described "${found.description}", the file says "${credits.description}"`);
    }
    const metadata = mergedTags(found.metadata, { [polarTags.brand]: catalog.brand, [polarTags.key]: credits.key });
    if (metadata) {
      body.metadata = metadata;
      if (!adopting) changes.push("tag it as LobbyStack's");
    }
    if (Object.keys(body).length > 1) steps.push({ object: "credits", action: adopting ? "tag" : "update", subject, changes, method: "PATCH", path: `/v1/benefits/${found.id}`, body });
  }

  // Products, then the Credits each carries.
  const productIds = new Map<string, string | PolarRef>();
  const attach: PolarStep[] = [];
  for (const match of matches) {
    const { desired } = match;
    const key = productKey(desired.plan, desired.period);
    const subject = `Product "${desired.name}"`;
    const prices = desiredPrices(desired, meterIds);
    const tags = { [polarTags.brand]: catalog.brand, [polarTags.plan]: desired.plan, [polarTags.interval]: desired.period, [polarTags.terms]: desired.terms };
    const wantedCredits = desired.credits.map((creditKey) => creditIds.get(creditKey)).filter((id): id is string | PolarRef => id !== undefined);
    const found = match.found;
    if (!found) {
      steps.push({ object: "product", action: "create", subject, changes: [prices.map((price) => price.describe).join(", "), ...(desired.visibility === "private" ? ["private: only an API checkout sells it"] : [])], method: "POST", path: "/v1/products/", body: { name: desired.name, recurring_interval: desired.interval, recurring_interval_count: 1, visibility: desired.visibility, prices: prices.map((price) => price.body), metadata: tags }, produces: `product:${key}` });
      productIds.set(key, ref(`product:${key}`));
      if (match.replaced) late.push({ object: "product", action: "archive", subject: `Product "${match.replaced.name}"`, changes: ["replaced by a product with the file's billing cycle; its subscribers keep it"], method: "PATCH", path: `/v1/products/${match.replaced.id}`, body: { is_archived: true } });
      if (wantedCredits.length) attach.push({ object: "product", action: "attach", subject, changes: [`attach ${wantedCredits.length} Credits`], method: "POST", path: `/v1/products/{{product:${key}}}/benefits`, body: { benefits: wantedCredits } });
      continue;
    }
    productIds.set(key, found.id);
    const changes: string[] = [];
    const body: Record<string, unknown> = {};
    if (match.restoring) {
      body.is_archived = false;
      changes.push("bring it back: the file sells this period again");
    }
    if (match.adopting) changes.push("tag it as LobbyStack's");
    if (found.name !== desired.name) {
      body.name = desired.name;
      changes.push(`named "${found.name}", the file says "${desired.name}"`);
    }
    if ((found.visibility ?? "public") !== desired.visibility) {
      body.visibility = desired.visibility;
      changes.push(`${found.visibility ?? "public"}, the file says ${desired.visibility}`);
    }
    // A price's amount never changes in Polar: the update sends every price it keeps by id plus the new ones, and Polar archives the rest.
    const current = livePrices(found);
    const kept = new Set<string>();
    const added: DesiredPrice[] = [];
    for (const price of prices) {
      const same = current.find((candidate) => !kept.has(candidate.id) && price.matches(candidate));
      if (same) kept.add(same.id);
      else added.push(price);
    }
    const dropped = current.filter((price) => !kept.has(price.id));
    if (added.length || dropped.length) {
      body.prices = [...[...kept].map((id) => ({ id })), ...added.map((price) => price.body)];
      changes.push(...added.map((price) => `add ${price.describe}`), ...dropped.map((price) => `drop ${describePrice(price, snapshot.meters)}`));
    }
    const metadata = mergedTags(found.metadata, tags);
    if (metadata) {
      body.metadata = metadata;
      if (!match.adopting) changes.push(found.metadata[polarTags.terms] !== undefined && found.metadata[polarTags.terms] !== desired.terms ? `made from older terms (${String(found.metadata[polarTags.terms]).slice(0, 6)})` : "tag it as LobbyStack's");
    }
    if (Object.keys(body).length) steps.push({ object: "product", action: match.adopting ? "tag" : "update", subject, changes, method: "PATCH", path: `/v1/products/${found.id}`, body });
    // Other kinds of benefit stay; Credits are exactly the file's, so no allowance comes off twice.
    const attached = found.benefits;
    const others = attached.filter((benefit) => benefit.type !== "meter_credit").map((benefit) => benefit.id);
    const strays = attached.filter((benefit) => benefit.type === "meter_credit" && !wantedCredits.includes(benefit.id));
    const missing = wantedCredits.filter((id) => isRef(id) || !attached.some((benefit) => benefit.id === id));
    if (strays.length || missing.length) {
      attach.push({ object: "product", action: "attach", subject, changes: [...(missing.length ? [`attach ${missing.length} Credits`] : []), ...strays.map((benefit) => `detach ${quoted([benefit])}${desired.period === "annual" ? ": annual plans report only the overage" : ""}`)], method: "POST", path: `/v1/products/${found.id}/benefits`, body: { benefits: [...others, ...wantedCredits] } });
    }
  }
  steps.push(...attach);

  // Products this brand no longer sells.
  const wantedProducts = new Set(catalog.products.map((product) => productKey(product.plan, product.period)));
  for (const product of snapshot.products) {
    if (product.is_archived || !ours(product.metadata) || wantedProducts.has(productKey(String(product.metadata[polarTags.plan]), String(product.metadata[polarTags.interval])))) continue;
    const subject = `Product "${product.name}"`;
    if (!options.allowArchive) refuse("product", subject, `It sells ${String(product.metadata[polarTags.plan])} ${String(product.metadata[polarTags.interval])}, which the file no longer has. Run with --allow-archive to archive it; its subscribers keep their subscription.`);
    else late.push({ object: "product", action: "archive", subject, changes: ["the file no longer sells it; its subscribers keep their subscription"], leftover: true, method: "PATCH", path: `/v1/products/${product.id}`, body: { is_archived: true } });
  }

  // Discounts: code-less, so only an API checkout applies one.
  const liveDiscounts = snapshot.discounts.filter((discount) => ours(discount.metadata) && discountLive(discount, now));
  for (const desired of catalog.discounts) {
    const subject = `Discount "${desired.name}"`;
    const withTag = liveDiscounts.filter((discount) => discount.metadata[polarTags.plan] === desired.plan);
    if (withTag.length > 1) {
      refuse("discount", subject, `${withTag.length} live discounts are tagged ${catalog.brand} ${desired.plan} (${quoted(withTag)}). End all but one in Polar.`);
      continue;
    }
    const wanted = desired.discount;
    const amounts = wanted.type === "percentage" ? { basis_points: wanted.basis_points } : { amounts: { [desired.currency]: wanted.amount_cents } };
    const months = wanted.duration === "repeating" ? { duration_in_months: wanted.duration_in_months } : {};
    const products = desired.products.map((key) => productIds.get(key)).filter((id): id is string | PolarRef => id !== undefined);
    const tags = { [polarTags.brand]: catalog.brand, [polarTags.plan]: desired.plan, [polarTags.terms]: desired.terms };
    const create = (changes: string[]) => steps.push({ object: "discount", action: "create", subject, changes, method: "POST", path: "/v1/discounts/", body: { name: desired.name, type: wanted.type, ...amounts, duration: wanted.duration, ...months, products, metadata: tags }, produces: `discount:${desired.plan}` });
    const found = withTag[0];
    if (!found) {
      create([`${discountAmountText(wanted, desired.currency)}, no code`]);
      continue;
    }
    const amountChanged = (wanted.type === "percentage" ? found.basis_points !== wanted.basis_points : found.amounts?.[desired.currency] !== wanted.amount_cents) || (found.duration_in_months ?? null) !== (wanted.duration_in_months ?? null);
    if (found.type !== wanted.type || found.duration !== wanted.duration || (amountChanged && found.redemptions_count > 0)) {
      // Polar never changes a discount's type or duration, nor its amounts once redeemed.
      if (!options.allowReplace) {
        refuse("discount", subject, `"${found.name}" can't become ${discountAmountText(wanted, desired.currency)} in place${found.redemptions_count > 0 ? `: it was redeemed ${found.redemptions_count} times` : ""}. Run with --allow-replace to make a new discount and end this one now; those who redeemed it keep it.`);
        continue;
      }
      create([`replaces "${found.name}": ${discountAmountText(wanted, desired.currency)}`]);
      late.push({ object: "discount", action: "end", subject: `Discount "${found.name}"`, changes: ["replaced; those who redeemed it keep it"], method: "PATCH", path: `/v1/discounts/${found.id}`, body: { ends_at: now } });
      continue;
    }
    const changes: string[] = [];
    const body: Record<string, unknown> = {};
    if (amountChanged) {
      Object.assign(body, amounts, months);
      changes.push(`amount changes to ${discountAmountText(wanted, desired.currency)}`);
    }
    const currentProducts = found.products.map((product) => product.id).sort();
    if (products.some(isRef) || JSON.stringify(currentProducts) !== JSON.stringify(products.map((id) => idText(id)).sort())) {
      body.products = products;
      changes.push("limited to the plan's products");
    }
    if (found.code !== null) {
      body.code = null;
      changes.push(`has code ${found.code}, the file says none`);
    }
    if (found.name !== desired.name) {
      body.name = desired.name;
      changes.push(`named "${found.name}", the file says "${desired.name}"`);
    }
    const metadata = mergedTags(found.metadata, tags);
    if (metadata) {
      body.metadata = metadata;
      changes.push("made from older terms");
    }
    if (Object.keys(body).length) steps.push({ object: "discount", action: "update", subject, changes, method: "PATCH", path: `/v1/discounts/${found.id}`, body });
  }
  const discountPlans = new Set(catalog.discounts.map((discount) => discount.plan));
  for (const discount of liveDiscounts) {
    if (discountPlans.has(String(discount.metadata[polarTags.plan]))) continue;
    const subject = `Discount "${discount.name}"`;
    if (!options.allowArchive) refuse("discount", subject, `The file no longer gives ${String(discount.metadata[polarTags.plan])} a discount. Run with --allow-archive to end it now; those who redeemed it keep it.`);
    else late.push({ object: "discount", action: "end", subject, changes: ["the file no longer has it; those who redeemed it keep it"], leftover: true, method: "PATCH", path: `/v1/discounts/${discount.id}`, body: { ends_at: now } });
  }

  // The webhook, found by its address.
  if (catalog.webhook) {
    const { url, events } = catalog.webhook;
    const subject = `Webhook ${url}`;
    const same = snapshot.webhooks.filter((endpoint) => trimSlash(endpoint.url) === trimSlash(url));
    if (same.length > 1) refuse("webhook", subject, `${same.length} webhooks point at ${url}. Delete all but one in Polar.`);
    else if (!same[0]) steps.push({ object: "webhook", action: "create", subject, changes: [`Raw, ${events.length} events`], method: "POST", path: "/v1/webhooks/endpoints", body: { url, name: "LobbyStack", format: "raw", events } });
    else {
      const endpoint = same[0];
      const body: Record<string, unknown> = {};
      const changes: string[] = [];
      if (endpoint.format !== "raw") {
        body.format = "raw";
        changes.push(`${endpoint.format} format, LobbyStack needs Raw`);
      }
      if (endpoint.enabled === false) {
        body.enabled = true;
        changes.push("turned off");
      }
      const missing = events.filter((event) => !endpoint.events.includes(event));
      if (missing.length) {
        body.events = [...endpoint.events, ...missing];
        changes.push(`add ${missing.join(", ")}`);
      }
      if (changes.length) steps.push({ object: "webhook", action: "update", subject, changes, method: "PATCH", path: `/v1/webhooks/endpoints/${endpoint.id}`, body });
    }
  }

  return { steps: [...steps, ...late, ...lateMeters], refusals };
}

// Running a plan.

export type PolarCaller = { request(method: "POST" | "PATCH", path: string, body: unknown): Promise<unknown> };

function resolveRefs(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (isRef(value)) {
    const id = ids.get(value.$ref);
    if (!id) throw new Error(`No Polar id for ${value.$ref}: the call that makes it didn't run.`);
    return id;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveRefs(entry, ids));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveRefs(entry, ids)]));
  return value;
}

/**
 * Makes each call in order, putting the ids of objects made earlier into the
 * ones after. Stops at the first failure: what landed is found again by its
 * tags on the next run. Returns the new webhook's secret, when one was made;
 * onStep hears it with the call that made the webhook, so a caller keeps it
 * even when a later call fails.
 */
export async function runPolarSteps(caller: PolarCaller, steps: readonly PolarStep[], onStep?: (step: PolarStep, webhookSecret: string | null) => void): Promise<{ webhookSecret: string | null }> {
  const ids = new Map<string, string>();
  let webhookSecret: string | null = null;
  for (const step of steps) {
    const path = step.path.replace(/\{\{([^{}]+)\}\}/g, (_match, name: string) => resolveRefs(ref(name), ids) as string);
    const result = (await caller.request(step.method, path, resolveRefs(step.body, ids))) as { id?: unknown; secret?: unknown } | null;
    if (step.produces) {
      if (typeof result?.id !== "string") throw new Error(`Polar made ${step.subject} but sent no id back. Run again: it is found by its tags.`);
      ids.set(step.produces, result.id);
    }
    const secret = step.object === "webhook" && step.action === "create" && typeof result?.secret === "string" ? result.secret : null;
    if (secret) webhookSecret = secret;
    onStep?.(step, secret);
  }
  return { webhookSecret };
}

// Links.

/**
 * The link request for a snapshot taken once Polar sells what the file says:
 * every live price of every sold plan with the live product tagged for it,
 * and each plan's discount. missing names what has no single tagged object.
 */
export function polarLinkPlans(input: { catalog: DesiredPolarCatalog; plans: readonly DesiredBillingPlan[]; snapshot: PolarSnapshot; now?: string }): { plans: ApiBillingCatalogLink["plans"]; missing: string[] } {
  const now = input.now ?? new Date().toISOString();
  const brand = input.catalog.brand;
  const missing: string[] = [];
  const plans: ApiBillingCatalogLink["plans"] = [];
  for (const plan of input.plans) {
    if (!plan.sold || !plan.prices.length) continue;
    const prices = plan.prices.map((price) => {
      const live = input.snapshot.products.filter((product) => !product.is_archived && product.metadata[polarTags.brand] === brand && product.metadata[polarTags.plan] === plan.code && product.metadata[polarTags.interval] === price.period);
      if (live.length !== 1) missing.push(`${plan.code} ${price.period}: ${live.length} live products tagged for it`);
      return { period: price.period, currency: price.currency, polar_id: live[0]?.id ?? "" };
    });
    let discount: string | null = null;
    if (plan.discount) {
      const live = input.snapshot.discounts.filter((entry) => entry.metadata[polarTags.brand] === brand && entry.metadata[polarTags.plan] === plan.code && discountLive(entry, now));
      if (live.length !== 1) missing.push(`${plan.code} discount: ${live.length} live discounts tagged for it`);
      discount = live[0]?.id ?? null;
    }
    plans.push({ code: plan.code, terms_hash: plan.terms_hash, polar_disc: discount, prices });
  }
  return { plans, missing };
}
