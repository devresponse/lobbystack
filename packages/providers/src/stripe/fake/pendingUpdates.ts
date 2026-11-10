import type Stripe from "stripe";

import type { StripeApi } from "../client";
import { fakeCardOutcomes, type FakeCard } from "./cards";
import { idOf, type FakeStripeContext } from "./context";
import { invalid, missing } from "./errors";
import { stripeInvoiceObject } from "./objects";

// Plan changes now (the Stripe plan's step 14): an update that makes an
// invoice charges the customer's card, as Stripe's test cards say. With
// payment_behavior pending_if_incomplete, a payment the card declines, or
// that needs the customer, leaves a pending update on the open invoice. A
// test pays it (payFakeInvoice), which applies the update, and voiding the
// invoice or the update's expiry (dropFakePendingUpdate) drops it.

const DAY = 24 * 60 * 60;

/** The card a subscription's invoices charge: its own default, else its customer's, else a good Visa. */
function cardOf(fake: FakeStripeContext, subscription: Stripe.Subscription): FakeCard {
  const customer = fake.state.customers.get(idOf(subscription.customer) ?? "") as Stripe.Customer | undefined;
  const card = idOf(subscription.default_payment_method) ?? idOf(customer?.invoice_settings?.default_payment_method ?? null) ?? "pm_card_visa";
  return (card in fakeCardOutcomes ? card : "pm_card_visa") as FakeCard;
}

/** The subscription with an update's item prices, discounts, cycle and metadata applied. */
function withChanges(fake: FakeStripeContext, subscription: Stripe.Subscription, params: Stripe.SubscriptionUpdateParams): Stripe.Subscription {
  const now = fake.clock.now();
  const data = subscription.items.data.map((item) => {
    const price = params.items?.find((entry) => entry.id === item.id)?.price;
    const catalog = price ? fake.state.catalog.prices.find((entry) => entry.id === price) : undefined;
    const moved = price ? { ...item, price: { ...item.price, id: price, recurring: { ...item.price.recurring, interval: catalog?.recurring?.interval ?? item.price.recurring?.interval ?? "month" } } } : item;
    // A new period from now, as billing_cycle_anchor { type: now } starts one.
    return params.billing_cycle_anchor?.type === "now" ? { ...moved, current_period_start: now, current_period_end: now + (moved.price.recurring?.interval === "year" ? 365 : 30) * DAY } : moved;
  });
  const discounts = params.discounts === undefined
    ? subscription.discounts
    : !params.discounts ? [] : params.discounts.map((discount, position) => ({ id: `di_${subscription.id}_${now}_${position}`, object: "discount", source: { coupon: discount.coupon, type: "coupon" }, subscription: subscription.id, start: now, end: null }));
  return { ...subscription, items: { ...subscription.items, data }, discounts, metadata: { ...subscription.metadata, ...((params.metadata ?? {}) as Record<string, string>) } } as unknown as Stripe.Subscription;
}

/**
 * An update to a subscription's items, discounts or cycle. One that invoices
 * now (always_invoice, or a cycle from now) charges the card: paid, it
 * applies; declined or needing the customer, it waits as a pending update
 * with pending_if_incomplete, and applies all the same without it.
 */
export function updateWithPayment(fake: FakeStripeContext, subscription: Stripe.Subscription, params: Stripe.SubscriptionUpdateParams): Stripe.Subscription {
  const changed = withChanges(fake, subscription, params);
  if (params.proration_behavior !== "always_invoice" && params.billing_cycle_anchor?.type !== "now") return changed;
  // A new change replaces a pending one, voiding the invoice that one made.
  const current = dropFakePendingUpdate(fake, subscription.id) ?? subscription;
  const outcome = fakeCardOutcomes[cardOf(fake, current)];
  const invoice = stripeInvoiceObject({ id: fake.nextId("in"), customer: idOf(current.customer) ?? "", subscription: current.id, status: outcome === "succeeded" ? "paid" : "open", amountDue: 1_000 });
  fake.state.invoices.set(invoice.id, invoice);
  fake.state.invoicePayments.push({ invoice: invoice.id, paymentIntent: fake.nextId("pi"), status: outcome === "succeeded" ? "succeeded" : outcome === "declined" ? "requires_payment_method" : "requires_action" });
  if (outcome === "succeeded" || params.payment_behavior !== "pending_if_incomplete") return { ...withChanges(fake, current, params), latest_invoice: invoice.id } as Stripe.Subscription;
  fake.state.pendingUpdates.set(current.id, { invoice: invoice.id, params });
  const pendingItems = changed.items.data.filter((item, position) => item.price.id !== current.items.data[position]?.price.id);
  return { ...current, latest_invoice: invoice.id, pending_update: { expires_at: fake.clock.now() + 23 * 60 * 60, subscription_items: pendingItems, billing_cycle_anchor: null, trial_end: null, trial_from_plan: null } } as unknown as Stripe.Subscription;
}

/** Drops a subscription's pending update, voiding its invoice, as its expiry does. The subscription after, or undefined without one. */
export function dropFakePendingUpdate(fake: FakeStripeContext, subscriptionId: string): Stripe.Subscription | undefined {
  const pending = fake.state.pendingUpdates.get(subscriptionId);
  if (!pending) return undefined;
  fake.state.pendingUpdates.delete(subscriptionId);
  const invoice = fake.state.invoices.get(pending.invoice);
  if (invoice?.status === "open") fake.state.invoices.set(invoice.id, { ...invoice, status: "void" } as Stripe.Invoice);
  const subscription = fake.state.subscriptions.get(subscriptionId);
  if (!subscription) return undefined;
  const dropped = { ...subscription, pending_update: null } as Stripe.Subscription;
  fake.state.subscriptions.set(subscriptionId, dropped);
  return dropped;
}

/** Pays an open invoice, as the customer does on its page after confirming with the bank, applying the pending update it carries. */
export function payFakeInvoice(fake: FakeStripeContext, invoiceId: string): Stripe.Invoice {
  const invoice = fake.state.invoices.get(invoiceId);
  if (!invoice || invoice.status !== "open") throw new Error(`Invoice ${invoiceId} isn't open.`);
  const paid = { ...invoice, status: "paid" } as Stripe.Invoice;
  fake.state.invoices.set(invoiceId, paid);
  for (const payment of fake.state.invoicePayments) if (payment.invoice === invoiceId) payment.status = "succeeded";
  for (const [subscriptionId, pending] of fake.state.pendingUpdates) {
    if (pending.invoice !== invoiceId) continue;
    fake.state.pendingUpdates.delete(subscriptionId);
    const subscription = fake.state.subscriptions.get(subscriptionId)!;
    fake.state.subscriptions.set(subscriptionId, { ...withChanges(fake, subscription, pending.params), pending_update: null } as Stripe.Subscription);
  }
  return paid;
}

/** invoices.voidInvoice: an open invoice becomes void, dropping the pending update it carries. */
export function fakeInvoices(fake: FakeStripeContext): StripeApi["invoices"] {
  return {
    async voidInvoice(id: string, params: Stripe.InvoiceVoidInvoiceParams = {}, options: Stripe.RequestOptions = {}) {
      return await fake.call("invoices.voidInvoice", { id, ...params }, options.idempotencyKey ?? null, () => {
        const invoice = fake.state.invoices.get(id);
        if (!invoice) throw missing("invoice", id);
        if (invoice.status !== "open" && invoice.status !== "uncollectible") throw invalid(`You can only void invoices that are open or uncollectible. This invoice is ${invoice.status}.`);
        const voided = { ...invoice, status: "void" } as Stripe.Invoice;
        fake.state.invoices.set(id, voided);
        for (const [subscriptionId, pending] of fake.state.pendingUpdates) if (pending.invoice === id) dropFakePendingUpdate(fake, subscriptionId);
        return voided;
      });
    },
  } as unknown as StripeApi["invoices"];
}
