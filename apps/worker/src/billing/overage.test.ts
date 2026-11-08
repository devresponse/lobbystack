import { randomUUID } from "node:crypto";

import type { JobEnvelope } from "@lobbystack/contracts";
import { claimBillingSubscription, loadOverageWork, loadStripeSelling, recordDeletedBusinessPlanEnded, recordOverageSubscription, recordProductEvent, type OverageWork } from "@lobbystack/domain";
import type { StripeCatalogPrice } from "@lobbystack/providers/stripe/catalog";
import { StripeBilling } from "@lobbystack/providers/stripe/adapter";
import { createFakeStripe, type FakeStripe } from "@lobbystack/providers/stripe/fake";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lobbystack/shared", async (importOriginal) => (await import("./testing")).mockShared(importOriginal));
vi.mock("@lobbystack/domain", async (importOriginal) => ({
  ...(await (await import("./testing")).mockDomain(importOriginal)),
  loadOverageWork: vi.fn(),
  recordOverageSubscription: vi.fn(async () => true),
  recordDeletedBusinessPlanEnded: vi.fn(async () => true),
}));

import { handleJob } from "../handlers";

// The overage subscription on Stripe (the Stripe plan's step 13): the worker's
// billing.ensureOverage job and a deleted business's plan, on the in-memory Stripe.

const domain = { db: undefined as never };

afterEach(() => {
  vi.clearAllMocks();
});

function job(type: JobEnvelope["type"], businessId: string): JobEnvelope {
  return { jobId: randomUUID(), type, queue: "critical", businessId, payload: {}, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
}

/** A business that paid for Starter through a Stripe checkout, on an account selling the overage prices in CAD. */
async function paidThroughCheckout(): Promise<{ stripe: FakeStripe; billing: StripeBilling; plan: string }> {
  const stripe = createFakeStripe({ accountId: "acct_1" });
  stripe.addCustomer({ id: "cus_1", businessId: "b1" });
  const price = (id: string, lookupKey: string, extra: Partial<StripeCatalogPrice> = {}): StripeCatalogPrice => ({ id, active: true, product: "prod_1", currency: "cad", unit_amount: 3700, lookup_key: lookupKey, tax_behavior: "exclusive", recurring: { interval: "month", interval_count: 1, usage_type: "licensed", meter: null }, metadata: {}, created: 1, ...extra });
  const metered = (kind: string) => price(`price_overage_${kind}`, `ls_overage_${kind}_cad`, { unit_amount: 100, recurring: { interval: "month", interval_count: 1, usage_type: "metered", meter: `mtr_${kind}` } });
  stripe.loadCatalog({
    products: [{ id: "prod_1", name: "Starter", active: true, metadata: {}, tax_code: "txcd_10103001", created: 1 }],
    prices: [price("price_starter_month", "ls_lobbystack_starter_monthly_cad_12345678"), metered("voice"), metered("sms"), metered("transfers")],
    meters: ["voice", "sms", "transfers"].map((kind) => ({ id: `mtr_${kind}`, display_name: kind, event_name: `ls_overage_${kind}`, status: "active", default_aggregation: { formula: "sum" }, customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" }, value_settings: { event_payload_key: "value" } })),
  });
  const billing = new StripeBilling(stripe, { accountId: "acct_1", env: "sandbox" });
  const checkout = await billing.createCheckout({ customer: { id: "cus_1", billingKey: "business:b1" }, email: "owner@example.com", price: { ref: "price_starter_month", discountRef: null }, businessId: "b1", requestId: "request-1", metadata: { lobbystack_business: "b1" }, successUrl: "https://app.example/settings/plan", cancelUrl: "https://app.example/settings/plan", locale: null });
  return { stripe, billing, plan: stripe.completeCheckout(checkout.id, { card: "pm_card_1" }).id };
}

/** The plan's overage subscription, made or found, as the job would. */
async function overageOf(billing: StripeBilling, plan: string): Promise<string> {
  const made = await billing.ensureOverage({ customerId: "cus_1", planSubscriptionId: plan, businessId: "b1", currency: "cad" });
  if (!("subscriptionId" in made)) throw new Error("The overage subscription is unpaid.");
  return made.subscriptionId;
}

const overages = (stripe: FakeStripe) => [...stripe.state.subscriptions.values()].filter((subscription) => subscription.metadata.lobbystack_role === "overage");

const work = (fields: Partial<OverageWork>): OverageWork => ({ source: "stripe", customerId: "cus_1", subscriptionId: "sub_plan", subscriptionState: "active", cancelAt: null, overageSubscriptionId: null, periodStart: new Date(), currency: "cad", ...fields });

/** The JSON lines the worker logged at warn. */
function warnings(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.flatMap(([line]) => {
    try {
      return [JSON.parse(String(line)) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

describe("billing.ensureOverage", () => {
  it("gives a live Stripe plan its overage subscription once, and stores it", async () => {
    const { stripe, billing, plan } = await paidThroughCheckout();
    const businessId = randomUUID();
    vi.mocked(loadOverageWork).mockResolvedValue(work({ subscriptionId: plan }));
    const done = await handleJob(job("billing.ensureOverage", businessId), { domain, billing });
    const [overage] = overages(stripe);
    expect(done).toEqual({ status: "completed", entityId: overage!.id });
    expect(overage!.metadata).toEqual({ lobbystack_business: businessId, lobbystack_role: "overage", lobbystack_plan_subscription: plan });
    expect(recordOverageSubscription).toHaveBeenCalledWith(domain, { businessId, planSubscriptionId: plan, overageSubscriptionId: overage!.id });
    // A later plan event's run finds the same one.
    await handleJob(job("billing.ensureOverage", businessId), { domain, billing });
    expect(overages(stripe)).toHaveLength(1);
  });

  it("keeps the overage subscription while the plan is set to end, and ends it with its month once the plan has ended", async () => {
    const { stripe, billing, plan } = await paidThroughCheckout();
    const overage = await overageOf(billing, plan);
    // A yearly plan set to end next summer keeps its overage until then.
    vi.mocked(loadOverageWork).mockResolvedValue(work({ subscriptionId: plan, cancelAt: new Date("2027-07-01T00:00:00Z"), overageSubscriptionId: overage }));
    expect(await handleJob(job("billing.ensureOverage", randomUUID()), { domain, billing })).toEqual({ status: "completed", entityId: overage });
    expect(stripe.state.subscriptions.get(overage)!.cancel_at_period_end).toBe(false);
    vi.mocked(loadOverageWork).mockResolvedValue(work({ subscriptionId: plan, subscriptionState: "canceled", overageSubscriptionId: overage }));
    expect(await handleJob(job("billing.ensureOverage", randomUUID()), { domain, billing })).toEqual({ status: "completed", entityId: overage });
    expect(stripe.state.subscriptions.get(overage)).toMatchObject({ status: "active", cancel_at_period_end: true });
    // Once Stripe has ended it, the account has none, and there's nothing to do.
    vi.mocked(loadOverageWork).mockResolvedValue(work({ subscriptionId: plan, subscriptionState: "canceled" }));
    expect(await handleJob(job("billing.ensureOverage", randomUUID()), { domain, billing })).toMatchObject({ status: "skipped" });
  });

  it("names the plan subscription when its checkout sold the overage prices, as under merchant of record, and leaves its end to the plan", async () => {
    const { stripe, billing } = await paidThroughCheckout();
    const checkout = await billing.createCheckout({ customer: { id: "cus_1", billingKey: "business:b1" }, email: "owner@example.com", price: { ref: "price_starter_month", discountRef: null }, businessId: "b1", requestId: "request-2", metadata: { lobbystack_business: "b1" }, successUrl: "https://app.example/settings/plan", cancelUrl: "https://app.example/settings/plan", locale: null, overageOnCheckout: { currency: "cad" }, merchantOfRecord: true });
    const plan = stripe.completeCheckout(checkout.id).id;
    const businessId = randomUUID();
    vi.mocked(loadStripeSelling).mockResolvedValueOnce({ managedPayments: true, overage: "checkout", currency: "cad" });
    vi.mocked(loadOverageWork).mockResolvedValue(work({ subscriptionId: plan }));
    expect(await handleJob(job("billing.ensureOverage", businessId), { domain, billing })).toEqual({ status: "completed", entityId: plan });
    expect(recordOverageSubscription).toHaveBeenCalledWith(domain, { businessId, planSubscriptionId: plan, overageSubscriptionId: plan });
    expect(overages(stripe)).toEqual([]);
    // The plan's own end ends its overage, so there's nothing else to end.
    vi.mocked(loadOverageWork).mockResolvedValue(work({ subscriptionId: plan, subscriptionState: "canceled", overageSubscriptionId: plan }));
    expect(await handleJob(job("billing.ensureOverage", businessId), { domain, billing })).toMatchObject({ status: "skipped" });
    expect(stripe.state.subscriptions.get(plan)!.cancel_at_period_end).toBe(false);
  });

  it("makes no other while one Stripe ended after failed payments has its invoice open", async () => {
    const { stripe, billing, plan } = await paidThroughCheckout();
    const overage = await overageOf(billing, plan);
    stripe.state.invoices.set("in_overage", { id: "in_overage", object: "invoice", status: "open" } as never);
    stripe.state.subscriptions.set(overage, { ...stripe.state.subscriptions.get(overage)!, status: "canceled", cancellation_details: { comment: null, feedback: null, reason: "payment_failed" }, latest_invoice: "in_overage" } as never);
    vi.mocked(loadOverageWork).mockResolvedValue(work({ subscriptionId: plan }));
    expect(await handleJob(job("billing.ensureOverage", randomUUID()), { domain, billing })).toEqual({ status: "skipped", entityId: overage });
    expect(overages(stripe)).toHaveLength(1);
    expect(recordOverageSubscription).not.toHaveBeenCalled();
  });

  it("reports a plan live an hour without its overage subscription when it can't be made, and leaves Polar alone", async () => {
    const { billing, plan } = await paidThroughCheckout();
    const logs = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // The account sells no overage prices in USD.
      const businessId = randomUUID();
      vi.mocked(loadOverageWork).mockResolvedValue(work({ subscriptionId: plan, currency: "usd", periodStart: new Date(Date.now() - 2 * 60 * 60_000) }));
      await expect(handleJob(job("billing.ensureOverage", businessId), { domain, billing })).rejects.toMatchObject({ code: "not_found" });
      expect(warnings(logs)).toContainEqual(expect.objectContaining({ message: "ops.billing.overage_missing", businessId, provider: "stripe", planSubscriptionId: plan }));
      expect(recordProductEvent).toHaveBeenCalledWith(domain, expect.objectContaining({ name: "ops.billing.overage_missing", businessId, actorType: "worker", properties: { provider: "stripe", planSubscriptionId: plan } }));
      // Within the plan's first hour, the retry is enough.
      vi.mocked(recordProductEvent).mockClear();
      vi.mocked(loadOverageWork).mockResolvedValue(work({ subscriptionId: plan, currency: "usd" }));
      await expect(handleJob(job("billing.ensureOverage", businessId), { domain, billing })).rejects.toMatchObject({ code: "not_found" });
      expect(recordProductEvent).not.toHaveBeenCalledWith(domain, expect.objectContaining({ name: "ops.billing.overage_missing" }));
    } finally {
      logs.mockRestore();
    }
    const polar = { id: "polar", can: { separateOverage: false } } as never;
    expect(await handleJob(job("billing.ensureOverage", randomUUID()), { domain, billing: polar })).toMatchObject({ status: "skipped" });
  });
});

describe("a deleted business on Stripe", () => {
  it("ends the plan and its overage subscription now, each with its last invoice", async () => {
    const { stripe, billing, plan } = await paidThroughCheckout();
    const overage = await overageOf(billing, plan);
    vi.mocked(claimBillingSubscription).mockResolvedValue({ claimId: "subscription-claim" });
    vi.mocked(loadOverageWork).mockResolvedValue(work({ subscriptionId: plan, overageSubscriptionId: overage }));
    const businessId = randomUUID();
    expect(await handleJob({ ...job("billing.revokeSubscription", businessId), payload: { subscriptionId: plan } }, { domain, billing })).toEqual({ status: "completed", entityId: businessId });
    expect([stripe.state.subscriptions.get(plan)!.status, stripe.state.subscriptions.get(overage)!.status]).toEqual(["canceled", "canceled"]);
    expect([...stripe.state.invoices.values()].map((invoice) => invoice.parent?.subscription_details?.subscription).sort()).toEqual([overage, plan].sort());
    expect(recordDeletedBusinessPlanEnded).toHaveBeenCalledWith(domain, { businessId, subscriptionId: plan });
  });
});
