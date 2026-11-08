// pnpm billing:scenarios: the Stripe plan's sandbox scenarios (step 18), the
// list "Scenarios that must pass before live payments", run against a Stripe
// sandbox through LobbyStack's own Stripe adapter, each on a test clock of its
// own so it lives through renewals and the 1st's overage invoices in minutes.
//
//   STRIPE_SCENARIOS_KEY=sk_test_... pnpm billing:scenarios [--only usage,refund] [--brand realinfobot] [--parallel 4] [--keep]
//   pnpm billing:scenarios --list
//
// First it sets the sandbox up from the brand's billing.json, as pnpm billing
// apply does, with Stripe billing's recommended stripe block when the file has
// none, and without the webhook endpoint, which a deployment's own apply makes.
// The plan subscription is made through the API with Stripe's test cards, not
// through the Checkout page, which Stripe asks integrations not to script: the
// page is one of the checks by hand. Every customer and subscription is on a
// test clock, which the run deletes at the end unless --keep. Coupons it made
// are deleted too. It never prints the key. Exit codes: 0 every scenario
// passed, 1 one failed, 2 the run couldn't start.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { desiredBillingPlans } from "../packages/domain/src/server/billingCatalog";
import { stripePlanner } from "../packages/domain/src/server/billingStripe";
import { BillingProviderError } from "../packages/providers/src/billing/errors";
import type { NormalizedBillingEvent, OverageKind, PriceRef } from "../packages/providers/src/billing/types";
import { StripeBilling } from "../packages/providers/src/stripe/adapter";
import { createStripeCatalogClient, type StripeSnapshot } from "../packages/providers/src/stripe/catalog";
import { createStripeClient } from "../packages/providers/src/stripe/client";
import { StripeWebhook } from "../packages/providers/src/stripe/events";
import { BRANDS } from "../packages/shared/src/brands/generated";
import { billingProfileSchema, priceUsage, STRIPE_WEBHOOK_EVENTS, type BillingProfile, type PricedUsageKind } from "../packages/shared/src/index";
import {
  expectedOverageCents,
  firstOfMonth,
  inPool,
  nextFirstOfMonth,
  parseScenarioArgs,
  redactingOutput,
  sameCents,
  SCENARIO_STRIPE_BLOCK,
  SCENARIO_USAGE,
  SCENARIOS,
  scenarioKeyProblem,
  ScenarioUsage,
  type ScenarioName,
} from "./lib/billing-scenarios-core";

type Sdk = ReturnType<typeof createStripeClient>;
type Interval = "monthly" | "annual";
type Tier = "starter" | "pro";

export type ScenarioIo = { env: NodeJS.ProcessEnv; out(text: string): void; err(text: string): void };

/** A test clock: the scenario's own time, which only moves when it's advanced. */
type Clock = { id: string; time: Date; advance(to: Date): Promise<void> };

/** A business that bought a plan: its customer on a test clock, the plan subscription and the overage one. */
type Business = { scenario: ScenarioName; businessId: string; billingKey: string; customerId: string; planId: string; overageId: string; clock: Clock };

class ScenarioFailure extends Error {}

function expectThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ScenarioFailure(message);
}

// A public building's address, so Stripe Tax can work out the tax on the scenarios' invoices.
const SCENARIO_ADDRESS = { line1: "100 Queen St W", city: "Toronto", state: "ON", postal_code: "M5H 2N2", country: "CA" };
const GOOD_CARD = "pm_card_visa";
// The declining card that attaches: Stripe refuses to attach pm_card_chargeDeclined and pm_card_visa_chargeDeclined.
const DECLINED_CARD = "pm_card_chargeCustomerFail";
const THREE_D_SECURE_CARD = "pm_card_authenticationRequired";

const usageKindOf: Record<OverageKind, PricedUsageKind> = { voice: "voice_seconds", alert_sms: "alert_sms_segments", transfer: "outbound_call_attempts" };

/** What a scenario works with. */
type Context = {
  stripe: Sdk;
  billing: StripeBilling;
  currency: string;
  /** The usage grace hours of the brand's stripe block: the 1st's invoice is checked after them. */
  graceHours: number;
  /** Starter's overage rates in cents, from the brand's file. */
  rates: Record<OverageKind, number>;
  price(tier: Tier, interval: Interval): PriceRef;
  clock(label: string): Promise<Clock>;
  start(input: { scenario: ScenarioName; clock: Clock; tier: Tier; interval: Interval; coupon?: string }): Promise<Business>;
  setCard(customerId: string, card: string): Promise<void>;
  coupon(): Promise<string>;
  log(line: string): void;
};

/** Polls until check says yes, or fails with the message after the time. */
async function eventually(check: () => Promise<boolean>, message: string, withinMs = 5 * 60_000): Promise<void> {
  const until = Date.now() + withinMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new ScenarioFailure(message);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
  }
}

const requestId = () => `scenario-${randomUUID()}`;
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const DAY_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------- the scenarios

const scenarios: Record<Exclude<ScenarioName, "events">, (ctx: Context) => Promise<void>> = {
  async checkout(ctx) {
    const clock = await ctx.clock("checkout");
    for (const [tier, interval] of [["starter", "monthly"], ["pro", "annual"]] as const) {
      const business = await ctx.start({ scenario: "checkout", clock, tier, interval });
      const plan = await ctx.billing.getSubscription(business.planId);
      expectThat(plan?.state === "active", `${tier} ${interval} is ${plan?.state ?? "missing"}, not active`);
      expectThat(plan.priceRef === ctx.price(tier, interval).ref, `${tier} ${interval} sells ${plan.priceRef}, not the catalog's price`);
      const overage = await ctx.stripe.subscriptions.retrieve(business.overageId);
      expectThat(overage.status === "active", `the overage subscription of ${tier} ${interval} is ${overage.status}`);
      expectThat(overage.items.data.length === 3, `the overage subscription has ${overage.items.data.length} prices, not 3`);
      expectThat(overage.billing_cycle_anchor === seconds(nextFirstOfMonth(clock.time)), `the overage subscription is anchored on ${new Date(overage.billing_cycle_anchor * 1000).toISOString()}, not the next 1st at 00:00 UTC`);
      // A second try finds the same overage subscription.
      const again = await ctx.billing.ensureOverage({ customerId: business.customerId, planSubscriptionId: business.planId, businessId: business.businessId, currency: ctx.currency });
      expectThat("subscriptionId" in again && again.subscriptionId === business.overageId, "a second ensureOverage made another overage subscription");
    }
  },

  async usage(ctx) {
    const clock = await ctx.clock("usage");
    const business = await ctx.start({ scenario: "usage", clock, tier: "starter", interval: "monthly" });
    const customer = { id: business.customerId, billingKey: business.billingKey };
    const sent: number[] = [];
    const send = async (kind: OverageKind, units: number, identifier: string) => {
      const amountCents = priceUsage(usageKindOf[kind], units, ctx.rates[kind]);
      const result = await ctx.billing.reportUsage({ customer, businessId: business.businessId, kind, units, amountCents, occurredAt: clock.time, identifier });
      return { result, amountCents };
    };
    for (const [kind, units] of [["voice", 90], ["alert_sms", 3], ["transfer", 1]] as const) {
      const { result, amountCents } = await send(kind, units, `${kind}:${business.businessId}:0`);
      expectThat(result === "sent", `a ${kind} event came back ${result}`);
      sent.push(amountCents);
    }
    // The same identifier again counts once, whether Stripe refuses it or drops it.
    await send("voice", 90, `voice:${business.businessId}:0`);
    // A negative correction lowers the month.
    const correction = await send("voice", -30, `voice:${business.businessId}:1`);
    expectThat(correction.result === "sent", `the correction came back ${correction.result}`);
    sent.push(correction.amountCents);
    const expected = sent.reduce((sum, cents) => sum + cents, 0);
    const window = { customerId: business.customerId, from: firstOfMonth(clock.time), to: new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 60_000) };
    let held = 0;
    await eventually(async () => {
      const totals = await ctx.billing.usageTotals(window);
      held = totals.voice + totals.alert_sms + totals.transfer;
      return sameCents(held, expected);
    }, `the meters hold ${held} cents, and ${expected} were sent`);
    // On the 1st the overage subscription renews, and its invoice takes the month after the grace.
    await clock.advance(new Date(nextFirstOfMonth(clock.time).getTime() + (ctx.graceHours + 1) * 60 * 60_000));
    const invoices = await ctx.stripe.invoices.list({ subscription: business.overageId, limit: 10 });
    const cycle = invoices.data.find((invoice) => invoice.billing_reason === "subscription_cycle");
    expectThat(cycle, "the overage subscription has no invoice from the 1st");
    expectThat(cycle.subtotal === expectedOverageCents(sent), `the 1st's overage invoice is ${cycle.subtotal} cents before tax, and the usage sent comes to ${expectedOverageCents(sent)}`);
  },

  async "upgrade-paid"(ctx) {
    const clock = await ctx.clock("upgrade-paid");
    const business = await ctx.start({ scenario: "upgrade-paid", clock, tier: "starter", interval: "monthly" });
    const result = await ctx.billing.changePlan({ subscriptionId: business.planId, to: ctx.price("pro", "monthly"), discount: "remove", when: "now", proration: "invoice_now", requestId: requestId() });
    expectThat(result.status === "changed", `the upgrade came back ${result.status}`);
    const plan = await ctx.billing.getSubscription(business.planId);
    expectThat(plan?.priceRef === ctx.price("pro", "monthly").ref, "the plan isn't Pro after the upgrade");
  },

  async "upgrade-declined"(ctx) {
    const clock = await ctx.clock("upgrade-declined");
    const business = await ctx.start({ scenario: "upgrade-declined", clock, tier: "starter", interval: "monthly" });
    await ctx.setCard(business.customerId, DECLINED_CARD);
    let refusal: unknown = null;
    try {
      await ctx.billing.changePlan({ subscriptionId: business.planId, to: ctx.price("pro", "monthly"), discount: "remove", when: "now", proration: "invoice_now", requestId: requestId() });
    } catch (error) {
      refusal = error;
    }
    expectThat(refusal instanceof BillingProviderError && refusal.refusal === "payment_failed", `a declined upgrade ended with ${refusal instanceof Error ? refusal.message : "no refusal"}, not payment_failed`);
    const raw = await ctx.stripe.subscriptions.retrieve(business.planId);
    expectThat(raw.pending_update === null, "a pending update is left after the declined upgrade");
    const plan = await ctx.billing.getSubscription(business.planId);
    expectThat(plan?.priceRef === ctx.price("starter", "monthly").ref, "the plan moved although its payment was declined");
  },

  async "upgrade-3ds"(ctx) {
    const clock = await ctx.clock("upgrade-3ds");
    const business = await ctx.start({ scenario: "upgrade-3ds", clock, tier: "starter", interval: "monthly" });
    await ctx.setCard(business.customerId, THREE_D_SECURE_CARD);
    const result = await ctx.billing.changePlan({ subscriptionId: business.planId, to: ctx.price("pro", "monthly"), discount: "remove", when: "now", proration: "invoice_now", requestId: requestId() });
    expectThat(result.status === "needs_action", `an upgrade needing 3-D Secure came back ${result.status}`);
    expectThat(/^https:\/\//.test(result.url), "the upgrade gave no page to confirm the payment on");
    const raw = await ctx.stripe.subscriptions.retrieve(business.planId);
    expectThat(raw.pending_update !== null, "the upgrade waits on no pending update");
    const plan = await ctx.billing.getSubscription(business.planId);
    expectThat(plan?.priceRef === ctx.price("starter", "monthly").ref, "the plan moved before its payment was confirmed");
  },

  async downgrade(ctx) {
    const clock = await ctx.clock("downgrade");
    const business = await ctx.start({ scenario: "downgrade", clock, tier: "pro", interval: "monthly" });
    const starter = ctx.price("starter", "monthly");
    const schedule = async () => await ctx.billing.changePlan({ subscriptionId: business.planId, to: starter, discount: "remove", when: "renewal", proration: "none", requestId: requestId() });
    expectThat((await schedule()).status === "scheduled", "the downgrade wasn't scheduled for the renewal");
    let plan = await ctx.billing.getSubscription(business.planId);
    expectThat(plan?.next?.priceRef === starter.ref, "the plan shows no downgrade waiting for the renewal");
    // Keep my plan drops it.
    plan = await ctx.billing.keepPlan({ subscriptionId: business.planId, requestId: requestId() });
    expectThat(plan.next === null, "Keep my plan left the downgrade waiting");
    expectThat((await schedule()).status === "scheduled", "the second downgrade wasn't scheduled");
    plan = await ctx.billing.getSubscription(business.planId);
    expectThat(plan?.periodEnd, "the plan has no period end");
    await clock.advance(new Date(plan.periodEnd.getTime() + DAY_MS));
    plan = await ctx.billing.getSubscription(business.planId);
    expectThat(plan?.priceRef === starter.ref && plan.state === "active", `after the renewal the plan is ${plan?.state} on ${plan?.priceRef}, not active on Starter`);
  },

  async "cancel-resume"(ctx) {
    const clock = await ctx.clock("cancel-resume");
    const business = await ctx.start({ scenario: "cancel-resume", clock, tier: "starter", interval: "monthly" });
    let plan = await ctx.billing.cancel({ subscriptionId: business.planId, when: "renewal", requestId: requestId() });
    expectThat(plan?.cancelAt && plan.periodEnd && plan.cancelAt.getTime() === plan.periodEnd.getTime(), "a cancelled plan doesn't end at its renewal");
    plan = await ctx.billing.resume({ subscriptionId: business.planId, requestId: requestId() });
    expectThat(plan.cancelAt === null, "a resumed plan still ends");
    const again = await ctx.billing.ensureOverage({ customerId: business.customerId, planSubscriptionId: business.planId, businessId: business.businessId, currency: ctx.currency });
    expectThat("subscriptionId" in again && again.subscriptionId === business.overageId, "the overage subscription didn't stay with the resumed plan");
    // Cancelled for good: the plan ends at its renewal, and the worker ends the overage subscription with its month.
    plan = await ctx.billing.cancel({ subscriptionId: business.planId, when: "renewal", requestId: requestId() });
    expectThat(plan?.periodEnd, "the plan has no period end");
    await clock.advance(new Date(plan.periodEnd.getTime() + DAY_MS));
    plan = await ctx.billing.getSubscription(business.planId);
    expectThat(plan?.state === "canceled" || plan?.state === "ended", `after its renewal a cancelled plan is ${plan?.state}`);
    await ctx.billing.endOverage({ subscriptionId: business.overageId, when: "period_end" });
    const overage = await ctx.stripe.subscriptions.retrieve(business.overageId);
    expectThat(overage.cancel_at_period_end || overage.cancel_at !== null, "the overage subscription doesn't end with its month");
  },

  async "promo-endings"(ctx) {
    const clock = await ctx.clock("promo-endings");
    const coupon = await ctx.coupon();
    const starter = ctx.price("starter", "monthly");
    // Ends on the tier's price.
    const tier = await ctx.start({ scenario: "promo-endings", clock, tier: "starter", interval: "monthly", coupon });
    let plan = await ctx.billing.getSubscription(tier.planId);
    expectThat(plan?.discountRef, "the promo plan has no discount");
    plan = await ctx.billing.endAtRenewal({ subscriptionId: tier.planId, then: { ref: starter.ref, discountRef: null }, requestId: requestId() });
    expectThat(plan.next?.priceRef === starter.ref, "the promo plan's end on its tier's price isn't waiting for the renewal");
    // Ends cancelled.
    const cancel = await ctx.start({ scenario: "promo-endings", clock, tier: "starter", interval: "monthly", coupon });
    plan = await ctx.billing.endAtRenewal({ subscriptionId: cancel.planId, then: "cancel", requestId: requestId() });
    expectThat(plan.cancelAt !== null, "the promo plan that ends cancelled doesn't end");
    // A discount taken off.
    const discount = await ctx.start({ scenario: "promo-endings", clock, tier: "starter", interval: "monthly", coupon });
    plan = await ctx.billing.removeDiscount({ subscriptionId: discount.planId, requestId: requestId() });
    expectThat(plan.discountRef === null, "the discount is still on");
    const periodEnd = plan.periodEnd;
    expectThat(periodEnd, "the plan has no period end");
    await clock.advance(new Date(periodEnd.getTime() + DAY_MS));
    plan = await ctx.billing.getSubscription(tier.planId) ?? plan;
    expectThat(plan.priceRef === starter.ref && plan.discountRef === null && plan.state === "active", `after the renewal the promo plan is ${plan.state} on ${plan.priceRef} with discount ${plan.discountRef}, not active on Starter without one`);
    const ended = await ctx.billing.getSubscription(cancel.planId);
    expectThat(ended?.state === "canceled" || ended?.state === "ended", `after the renewal the promo plan that ends cancelled is ${ended?.state}`);
  },

  async deletion(ctx) {
    const clock = await ctx.clock("deletion");
    const business = await ctx.start({ scenario: "deletion", clock, tier: "starter", interval: "monthly" });
    expectThat(await ctx.billing.revoke({ subscriptionId: business.planId, requestId: requestId() }) === "ended", "revoking the plan didn't end it");
    await ctx.billing.endOverage({ subscriptionId: business.overageId, when: "now" });
    const plan = await ctx.stripe.subscriptions.retrieve(business.planId);
    const overage = await ctx.stripe.subscriptions.retrieve(business.overageId);
    expectThat(plan.status === "canceled" && overage.status === "canceled", `after the deletion the plan is ${plan.status} and the overage subscription ${overage.status}`);
    const lastInvoice = await ctx.stripe.invoices.list({ subscription: business.overageId, limit: 5 });
    expectThat(lastInvoice.data.length > 0, "the overage subscription ended without its last invoice");
    // A second revoke, as a retried job makes, counts as ended.
    expectThat(await ctx.billing.revoke({ subscriptionId: business.planId, requestId: requestId() }) === "already_ended", "a second revoke didn't count as already ended");
  },

  async refund(ctx) {
    const clock = await ctx.clock("refund");
    const business = await ctx.start({ scenario: "refund", clock, tier: "starter", interval: "monthly" });
    const plan = await ctx.stripe.subscriptions.retrieve(business.planId);
    const invoiceId = typeof plan.latest_invoice === "string" ? plan.latest_invoice : plan.latest_invoice?.id;
    expectThat(invoiceId, "the plan has no first invoice");
    const payments = await ctx.stripe.invoicePayments.list({ invoice: invoiceId, limit: 5 });
    const paymentIntent = payments.data.map((payment) => payment.payment.payment_intent).find((intent) => intent);
    const paymentIntentId = typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id;
    expectThat(paymentIntentId, "the plan's first invoice was paid with no payment intent");
    await ctx.stripe.refunds.create({ payment_intent: paymentIntentId, metadata: { lobbystack_scenario: "refund" } });
    expectThat(await ctx.billing.invoiceOfPayment(paymentIntentId) === invoiceId, "the refunded payment doesn't lead back to its invoice");
  },

  async totals(ctx) {
    const clock = await ctx.clock("totals");
    const business = await ctx.start({ scenario: "totals", clock, tier: "starter", interval: "monthly" });
    const customer = { id: business.customerId, billingKey: business.billingKey };
    const window = () => ({ customerId: business.customerId, from: firstOfMonth(clock.time), to: new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 60_000) });
    const voice = (units: number) => priceUsage("voice_seconds", units, ctx.rates.voice);
    // Two calls happened, and only the first reached Stripe.
    await ctx.billing.reportUsage({ customer, businessId: business.businessId, kind: "voice", units: 60, amountCents: voice(60), occurredAt: clock.time, identifier: `voice:${business.businessId}:a` });
    let held = 0;
    await eventually(async () => {
      held = (await ctx.billing.usageTotals(window())).voice;
      return sameCents(held, voice(60));
    }, `the voice meter holds ${held} cents, and ${voice(60)} were sent`);
    const gap = voice(60) + voice(120) - held;
    expectThat(sameCents(gap, voice(120)), `the gap is ${gap} cents, not the lost call's ${voice(120)}`);
    // The totals check's correction, numbered so a retried check sends it once.
    const identifier = `fix:${business.businessId}:${clock.time.toISOString().slice(0, 7)}:voice:0`;
    await ctx.billing.reportUsage({ customer, businessId: business.businessId, kind: "voice", units: 0, amountCents: gap, occurredAt: clock.time, identifier });
    await ctx.billing.reportUsage({ customer, businessId: business.businessId, kind: "voice", units: 0, amountCents: gap, occurredAt: clock.time, identifier });
    await eventually(async () => {
      held = (await ctx.billing.usageTotals(window())).voice;
      return sameCents(held, voice(180));
    }, `after the correction the voice meter holds ${held} cents, not ${voice(180)}`);
    // What a month can't take goes on the balance, once.
    const credit = { customerId: business.customerId, kind: "voice" as const, cents: 25, currency: ctx.currency, identifier: `credit:${business.businessId}:voice:0` };
    await ctx.billing.creditBalance(credit);
    await ctx.billing.creditBalance(credit);
    const credits = await ctx.billing.usageCredits({ customerId: business.customerId });
    expectThat(credits.voice === 25, `the balance holds ${credits.voice} cents of voice credit, not 25`);
  },
};

/** Every event of the scenarios' customers that Stripe's webhook would send, in LobbyStack's terms. */
async function checkEvents(ctx: Context, businesses: readonly Business[], since: Date, planFor: (ref: string | null | undefined) => { plan: string; code: string; interval: Interval } | null): Promise<void> {
  expectThat(businesses.length > 0, "no scenario made a business, so there are no events to check: run events with the others");
  const byCustomer = new Map(businesses.map((business) => [business.customerId, business]));
  const webhook = new StripeWebhook({ secrets: ["unused"], env: "sandbox" });
  const events = await ctx.stripe.events.list({ created: { gte: seconds(since) - 60 }, limit: 100 }).autoPagingToArray({ limit: 10_000 });
  const ours = events.filter((event) => {
    const customer = (event.data.object as { customer?: unknown }).customer;
    const id = typeof customer === "string" ? customer : (customer as { id?: string } | null | undefined)?.id;
    return (STRIPE_WEBHOOK_EVENTS as readonly string[]).includes(event.type) && id !== undefined && byCustomer.has(id);
  });
  const seen = new Set<string>();
  for (const event of ours) {
    const object = event.data.object as unknown as Record<string, unknown>;
    const normalized: NormalizedBillingEvent | null = webhook.normalize({ id: event.id, type: event.type, createdAt: new Date(event.created * 1000), livemode: event.livemode, object }, { planFor });
    expectThat(normalized, `${event.type} ${event.id} didn't normalize`);
    const customerId = normalized.fields.customerId;
    const business = customerId ? byCustomer.get(customerId) : undefined;
    expectThat(business, `${event.type} ${event.id} names no scenario customer`);
    // A charge names only its customer, whom the webhook route reads back; the others name their business.
    if (!event.type.startsWith("charge.")) expectThat(normalized.businessId === business.businessId, `${event.type} ${event.id} names business ${normalized.businessId}, not ${business.businessId}`);
    if (normalized.kind === "subscription") expectThat(normalized.fields.planCode, `${event.type} ${event.id} names no plan the catalog sells`);
    seen.add(`${event.type}:${normalized.kind}`);
  }
  for (const wanted of ["customer.subscription.created:subscription", "invoice.paid:payment"]) {
    expectThat(seen.has(wanted), `no ${wanted.split(":")[0]} event of the scenarios normalized as ${wanted.split(":")[1]} (${ours.length} events of theirs)`);
  }
}

// ---------------------------------------------------------------- setting up

type Setup = { snapshot: StripeSnapshot; prices: Map<string, string>; currency: string; graceHours: number; rates: Record<OverageKind, number>; planFor: (ref: string | null | undefined) => { plan: string; code: string; interval: Interval } | null };

async function readProfile(brand: string): Promise<{ profile: BillingProfile; withBlock: boolean }> {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  let text: string;
  try {
    text = await readFile(join(root, "brands", brand, "billing.json"), "utf8");
  } catch {
    throw new ScenarioUsage(`There's no brands/${brand}/billing.json in this checkout.`);
  }
  const parsed = billingProfileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new ScenarioUsage(`brands/${brand}/billing.json doesn't pass the schema.`);
  if (parsed.data.stripe) return { profile: parsed.data, withBlock: true };
  return { profile: { ...parsed.data, stripe: structuredClone(SCENARIO_STRIPE_BLOCK) } as BillingProfile, withBlock: false };
}

/** The brand's catalog in the sandbox, as pnpm billing apply makes it, without the webhook endpoint. */
async function setUp(key: string, brand: string, io: ScenarioIo): Promise<Setup> {
  const { profile, withBlock } = await readProfile(brand);
  if (!withBlock) io.out(`brands/${brand}/billing.json has no stripe block yet, so the run uses Stripe billing's recommended one.`);
  const plans = desiredBillingPlans(profile);
  const links = BRANDS[brand]?.links;
  const desired = stripePlanner.desired({ brand, profile, plans, webhookUrl: null, links: { termsUrl: links?.termsUrl ?? null, privacyUrl: links?.privacyUrl ?? null } });
  const catalog = createStripeCatalogClient(key);
  let snapshot = await catalog.readSnapshot({ webhooks: false });
  if (snapshot.mode !== "sandbox") throw new ScenarioUsage("The key isn't a sandbox's.");
  if (!snapshot.tax?.headOffice) throw new ScenarioUsage("Stripe Tax has no origin address in this sandbox, and every subscription here uses automatic tax. Set it in the Dashboard (Settings > Tax), then run again.");
  const plan = stripePlanner.plan({ desired, snapshot, options: { adopt: false, allowReplace: false, allowArchive: false } });
  if (plan.refusals.length) throw new ScenarioUsage(`The sandbox's catalog can't be set up as it is: ${plan.refusals.map((refusal) => refusal.message).join("; ")}`);
  if (plan.steps.length) {
    io.out(`Setting the sandbox up from brands/${brand}/billing.json: ${plan.steps.length} ${plan.steps.length === 1 ? "call" : "calls"}.`);
    await catalog.run(plan.steps);
    snapshot = await catalog.readSnapshot({ webhooks: false });
  }
  const prices = new Map<string, string>();
  for (const price of desired.prices) {
    const found = snapshot.prices.find((entry) => entry.active && entry.lookup_key === price.lookupKey);
    if (found) prices.set(`${price.plan}/${price.period}`, found.id);
  }
  const byId = new Map([...prices].map(([key, id]) => [id, key]));
  const planFor = (ref: string | null | undefined) => {
    const entry = ref ? byId.get(ref) : undefined;
    if (!entry) return null;
    const [code, interval] = entry.split("/") as [string, Interval];
    const tier = plans.find((candidate) => candidate.code === code)?.tier ?? code;
    return { plan: tier, code, interval };
  };
  const starter = profile.plans.starter.overageCents;
  return {
    snapshot,
    prices,
    currency: desired.currency,
    graceHours: desired.usageGraceHours,
    rates: { voice: starter.voiceMinute, alert_sms: starter.alertSmsSegment, transfer: starter.outboundCallAttempt },
    planFor,
  };
}

// ---------------------------------------------------------------- running

/** Runs the chosen scenarios and says how each went. Never throws. */
export async function runScenarios(argv: string[], io: ScenarioIo): Promise<number> {
  let options;
  try {
    options = parseScenarioArgs(argv);
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${SCENARIO_USAGE}`);
    return 2;
  }
  if (options.help) {
    io.out(SCENARIO_USAGE);
    return 0;
  }
  if (options.list) {
    for (const scenario of SCENARIOS) io.out(`${scenario.name.padEnd(17)} ${scenario.title}`);
    return 0;
  }
  const keyProblem = scenarioKeyProblem(io.env.STRIPE_SCENARIOS_KEY);
  if (keyProblem) {
    io.err(keyProblem);
    return 2;
  }
  const key = io.env.STRIPE_SCENARIOS_KEY!.trim();
  // Stripe's own errors repeat part of a key: everything the run says goes through redactKeys.
  io = redactingOutput(io);
  const started = new Date();
  let setup: Setup;
  try {
    setup = await setUp(key, options.brand, io);
  } catch (error) {
    io.err(`The sandbox couldn't be set up: ${(error as Error).message}`);
    return 2;
  }
  const stripe = createStripeClient(key);
  const billing = new StripeBilling(stripe, { accountId: setup.snapshot.account.id, env: "sandbox", deployment: "billing-scenarios" });
  const clocks: string[] = [];
  const coupons: string[] = [];
  const businesses: Business[] = [];
  const ctx: Context = {
    stripe,
    billing,
    currency: setup.currency,
    graceHours: setup.graceHours,
    rates: setup.rates,
    price(tier, interval) {
      const ref = setup.prices.get(`${tier}/${interval}`);
      if (!ref) throw new ScenarioFailure(`The catalog sells no ${tier} ${interval} price.`);
      return { ref, discountRef: null };
    },
    async clock(label) {
      const made = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: `LobbyStack scenario ${label}` });
      clocks.push(made.id);
      const clock: Clock = {
        id: made.id,
        time: new Date(made.frozen_time * 1000),
        async advance(to) {
          await stripe.testHelpers.testClocks.advance(made.id, { frozen_time: seconds(to) });
          // A clock takes from seconds to minutes to bring its customers' subscriptions and invoices up to the new time.
          await eventually(async () => {
            const current = await stripe.testHelpers.testClocks.retrieve(made.id);
            if (current.status === "internal_failure") throw new ScenarioFailure(`Stripe couldn't advance test clock ${made.id}.`);
            return current.status === "ready";
          }, `test clock ${made.id} was still advancing after 10 minutes`, 10 * 60_000);
          clock.time = to;
        },
      };
      return clock;
    },
    async start({ scenario, clock, tier, interval, coupon }) {
      const businessId = randomUUID();
      const billingKey = `business:${businessId}`;
      const customer = await stripe.customers.create({
        test_clock: clock.id,
        email: `scenario+${businessId.slice(0, 8)}@example.com`,
        name: `LobbyStack scenario ${scenario}`,
        address: SCENARIO_ADDRESS,
        metadata: { lobbystack_business: businessId, lobbystack_billing_key: billingKey, lobbystack_deployment: "billing-scenarios" },
      });
      await ctx.setCard(customer.id, GOOD_CARD);
      const metadata = { lobbystack_business: businessId, lobbystack_checkout: `scenario-${businessId}`, lobbystack_role: "plan" };
      const plan = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: ctx.price(tier, interval).ref }],
        ...(coupon ? { discounts: [{ coupon }] } : {}),
        metadata,
        automatic_tax: { enabled: true },
        payment_behavior: "error_if_incomplete",
      });
      const overage = await billing.ensureOverage({ customerId: customer.id, planSubscriptionId: plan.id, businessId, currency: setup.currency });
      expectThat("subscriptionId" in overage, `the ${tier} ${interval} plan got no overage subscription`);
      const business: Business = { scenario, businessId, billingKey, customerId: customer.id, planId: plan.id, overageId: overage.subscriptionId, clock };
      businesses.push(business);
      return business;
    },
    async setCard(customerId, card) {
      const method = await stripe.paymentMethods.attach(card, { customer: customerId });
      await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: method.id } });
    },
    async coupon() {
      const made = await stripe.coupons.create({ percent_off: 50, duration: "repeating", duration_in_months: 3, name: "LobbyStack scenario promo", metadata: { lobbystack_scenario: "promo" } });
      coupons.push(made.id);
      return made.id;
    },
    log: (line) => io.out(line),
  };

  const chosen = (options.only ?? SCENARIOS.map((scenario) => scenario.name)).filter((name) => name !== "events") as Exclude<ScenarioName, "events">[];
  const wantEvents = options.only === null || options.only.includes("events");
  io.out(`Running ${chosen.length + (wantEvents ? 1 : 0)} ${chosen.length + (wantEvents ? 1 : 0) === 1 ? "scenario" : "scenarios"} in Stripe sandbox ${setup.snapshot.account.id}, ${options.parallel} at once.`);
  const outcomes = await inPool(chosen, options.parallel, async (name) => await attempt(name, () => scenarios[name](ctx), io));
  if (wantEvents) outcomes.push(await attempt("events", () => checkEvents(ctx, businesses, started, setup.planFor), io));

  if (!options.keep) {
    for (const id of clocks) await stripe.testHelpers.testClocks.del(id).catch((error: Error) => io.err(`Couldn't delete test clock ${id}: ${error.message}`));
    for (const id of coupons) await stripe.coupons.del(id).catch((error: Error) => io.err(`Couldn't delete coupon ${id}: ${error.message}`));
  } else if (clocks.length) io.out(`Kept ${clocks.length} test ${clocks.length === 1 ? "clock" : "clocks"}: ${clocks.join(", ")}.`);
  const failed = outcomes.filter((outcome) => !outcome).length;
  io.out(failed ? `\n${failed} of ${outcomes.length} scenarios failed.` : `\nAll ${outcomes.length} scenarios passed.`);
  return failed ? 1 : 0;
}

/** Runs one scenario, and says whether it passed. A failure in it doesn't stop the others. */
async function attempt(name: ScenarioName, run: () => Promise<void>, io: ScenarioIo): Promise<boolean> {
  const started = Date.now();
  const took = () => `${Math.round((Date.now() - started) / 1000)} s`;
  try {
    await run();
    io.out(`ok    ${name} (${took()})`);
    return true;
  } catch (error) {
    const message = error instanceof ScenarioFailure ? error.message : `${(error as Error).name}: ${(error as Error).message}`;
    io.out(`FAIL  ${name} (${took()}): ${message}`);
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runScenarios(process.argv.slice(2), { env: process.env, out: (text) => console.log(text), err: (text) => console.error(text) });
}
