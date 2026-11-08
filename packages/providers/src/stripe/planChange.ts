import type Stripe from "stripe";

import { BillingProviderError } from "../billing/errors";
import type { BillingProvider, PlanChangeProration, PlanChangeResult, PriceRef, ProviderSubscription } from "../billing/types";
import type { StripeApi } from "./client";
import { providerSubscriptionFromStripe, stripePlanItem } from "./subscriptions";

// Plan changes on Stripe (the Stripe plan's step 14). A change now moves the
// plan's item to the new price as a pending update, which Stripe applies only
// once the invoice it makes is paid: paid at once, it's changed; a payment
// the bank wants confirmed, as with 3-D Secure, needs the customer on the
// invoice's page; and a declined one is voided, which drops the update. A
// change at the renewal, and a promo plan's end, is a subscription schedule
// whose second phase starts then.

type Discounts = Array<{ coupon: string }>;

const idOf = (value: string | { id: string } | null | undefined) => (typeof value === "string" ? value : value?.id ?? null);

/** How Stripe charges a change now: billing.json's words in the interface's terms. A restart starts a new period today, crediting what's left of the old one. */
const prorationBehaviors: Record<PlanChangeProration, Stripe.SubscriptionUpdateParams.ProrationBehavior> = {
  invoice_now: "always_invoice",
  next_invoice: "create_prorations",
  none: "none",
  restart: "create_prorations",
};

/** The subscription with what the read-back needs: its schedule, discounts and latest invoice. */
async function readStripeSubscription(api: StripeApi, id: string): Promise<Stripe.Subscription> {
  return await api.subscriptions.retrieve(id, { expand: ["schedule", "discounts", "latest_invoice"] });
}

/** The coupons of the subscription's discounts, expanded or not. */
function couponsOf(subscription: Stripe.Subscription): Discounts {
  return subscription.discounts.flatMap((discount) => {
    const coupon = typeof discount === "string" ? null : idOf(discount.source?.coupon ?? null);
    return coupon ? [{ coupon }] : [];
  });
}

/** What a change leaves the subscription's discounts as: the new price's coupon, none, or its own. */
function discountsAfter(discount: "price" | "remove" | "keep", to: PriceRef, subscription: Stripe.Subscription): Discounts {
  if (discount === "price") return to.discountRef ? [{ coupon: to.discountRef }] : [];
  return discount === "remove" ? [] : couponsOf(subscription);
}

/** The payment-needed refusal Stripe's declined upgrade becomes. */
function declinedChange(): BillingProviderError {
  return new BillingProviderError("stripe", "refused", "Stripe couldn't take the plan change's payment, so the change was dropped.", "payment_failed");
}

/**
 * Whether the invoice's payment waits for the customer: the bank wants it
 * confirmed, or it's still processing. A declined one doesn't.
 */
async function paymentWaitsForCustomer(api: StripeApi, invoiceId: string): Promise<boolean> {
  const payments = await api.invoicePayments.list({ invoice: invoiceId, expand: ["data.payment.payment_intent"] });
  return payments.data.some((entry) => {
    const intent = entry.payment.payment_intent;
    return typeof intent === "object" && intent !== null && (intent.status === "requires_action" || intent.status === "processing");
  });
}

/**
 * A change whose invoice isn't paid: its page when the payment waits for the
 * customer, else the invoice voided, which drops the pending update, and the
 * change refused as payment_failed.
 */
async function pendingChange(api: StripeApi, subscription: Stripe.Subscription, requestId: string): Promise<PlanChangeResult> {
  const invoiceId = idOf(subscription.latest_invoice);
  if (invoiceId && await paymentWaitsForCustomer(api, invoiceId)) {
    const read = providerSubscriptionFromStripe(await readStripeSubscription(api, subscription.id));
    const url = read.pendingPayment?.url ?? (typeof subscription.latest_invoice === "object" ? subscription.latest_invoice?.hosted_invoice_url : null);
    if (url) return { status: "needs_action", url, subscription: read };
  }
  if (invoiceId) await api.invoices.voidInvoice(invoiceId, {}, { idempotencyKey: `plan-change-void:${requestId}` });
  throw declinedChange();
}

/**
 * Moves the plan's item to another price now, or at the renewal. A change now
 * replaces one waiting for the renewal, as Polar's does, and a retried job
 * whose upgrade waits for its payment gets that payment's page again.
 */
export async function changeStripePlan(api: StripeApi, input: Parameters<BillingProvider["changePlan"]>[0]): ReturnType<BillingProvider["changePlan"]> {
  const subscription = await readStripeSubscription(api, input.subscriptionId);
  const item = stripePlanItem(subscription);
  if (!item) throw new BillingProviderError("stripe", "not_found", `Stripe subscription ${subscription.id} has no plan item.`, "subscription_unavailable");
  if (input.when === "renewal") {
    const scheduled = await scheduleStripeChange(api, subscription, { to: input.to, discounts: discountsAfter(input.discount, input.to, subscription), ...(input.metadata ? { metadata: input.metadata } : {}), key: `schedule:${input.requestId}` });
    return { status: "scheduled", subscription: scheduled };
  }
  const waiting = subscription.pending_update?.subscription_items?.some((entry) => idOf(entry.price) === input.to.ref);
  if (waiting) return await pendingChange(api, subscription, input.requestId);
  const schedule = idOf(subscription.schedule);
  if (schedule) await api.subscriptionSchedules.release(schedule, {}, { idempotencyKey: `plan-change-release:${input.requestId}` });
  const discounts = input.discount === "keep" ? undefined : discountsAfter(input.discount, input.to, subscription);
  const updated = await api.subscriptions.update(subscription.id, {
    items: [{ id: item.id, price: input.to.ref }],
    proration_behavior: prorationBehaviors[input.proration],
    // Applied only once its invoice is paid; one that makes no invoice applies at once.
    payment_behavior: "pending_if_incomplete",
    ...(input.proration === "restart" ? { billing_cycle_anchor: { type: "now" as const } } : {}),
    ...(discounts ? { discounts: discounts.length ? discounts : "" as const } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    expand: ["latest_invoice"],
  }, { idempotencyKey: `plan-change:${input.requestId}` });
  if (updated.pending_update) return await pendingChange(api, updated, input.requestId);
  return { status: "changed", subscription: providerSubscriptionFromStripe(await readStripeSubscription(api, subscription.id)) };
}

/**
 * Moves the plan's item to `to` at the renewal: the subscription's schedule,
 * or a new one made from it, keeps the current phase to the period's end and
 * adds a second on the new price, then lets the subscription go on its own.
 * An upgrade waiting for its payment would be dropped by the phase, so it
 * refuses as change_pending.
 */
async function scheduleStripeChange(api: StripeApi, subscription: Stripe.Subscription, input: { to: PriceRef; discounts: Discounts; metadata?: Record<string, string>; key: string }): Promise<ProviderSubscription> {
  if (subscription.pending_update) throw new BillingProviderError("stripe", "refused", `Stripe subscription ${subscription.id} has an upgrade waiting for its payment.`, "change_pending");
  const item = stripePlanItem(subscription)!;
  const schedule = typeof subscription.schedule === "object" && subscription.schedule
    ? subscription.schedule
    : await api.subscriptionSchedules.create({ from_subscription: subscription.id }, { idempotencyKey: `${input.key}:schedule` });
  const periodEnd = item.current_period_end;
  // The phase in force now: the one that ends with the period, or the schedule's first.
  const current = schedule.phases.find((phase) => phase.start_date <= item.current_period_start && (phase.end_date ?? Number.POSITIVE_INFINITY) > item.current_period_start) ?? schedule.phases[0];
  if (!current) throw new BillingProviderError("stripe", "not_found", `Stripe subscription schedule ${schedule.id} has no phase.`, "subscription_unavailable");
  const currentDiscounts = (current.discounts ?? []).flatMap((discount) => {
    const coupon = idOf(discount.coupon);
    return coupon ? [{ coupon }] : [];
  });
  await api.subscriptionSchedules.update(schedule.id, {
    end_behavior: "release",
    phases: [
      { items: current.items.map((entry) => ({ price: idOf(entry.price)!, quantity: entry.quantity ?? 1 })), start_date: current.start_date, end_date: periodEnd, discounts: currentDiscounts.length ? currentDiscounts : "" },
      { items: [{ price: input.to.ref, quantity: 1 }], discounts: input.discounts.length ? input.discounts : "", ...(input.metadata ? { metadata: input.metadata } : {}) },
    ],
  }, { idempotencyKey: `${input.key}:phases` });
  return providerSubscriptionFromStripe(await readStripeSubscription(api, subscription.id));
}

/**
 * A promo plan's end at the renewal: a second phase on its tier's price
 * without the promo's coupon, or the subscription set to cancel then, after
 * releasing a schedule whose phase would undo the end.
 */
export async function endStripePlanAtRenewal(api: StripeApi, input: Parameters<BillingProvider["endAtRenewal"]>[0]): ReturnType<BillingProvider["endAtRenewal"]> {
  const subscription = await readStripeSubscription(api, input.subscriptionId);
  if (input.then !== "cancel") return await scheduleStripeChange(api, subscription, { to: input.then, discounts: input.then.discountRef ? [{ coupon: input.then.discountRef }] : [], key: input.requestId });
  const schedule = idOf(subscription.schedule);
  if (schedule) await api.subscriptionSchedules.release(schedule, {}, { idempotencyKey: `${input.requestId}:release` });
  await api.subscriptions.update(subscription.id, { cancel_at_period_end: true }, { idempotencyKey: input.requestId });
  return providerSubscriptionFromStripe(await readStripeSubscription(api, subscription.id));
}

/** Removes the subscription's discounts, which leaves its next invoices at the full price. */
export async function removeStripeDiscount(api: StripeApi, input: Parameters<BillingProvider["removeDiscount"]>[0]): ReturnType<BillingProvider["removeDiscount"]> {
  await api.subscriptions.update(input.subscriptionId, { discounts: "" }, { idempotencyKey: input.requestId });
  return providerSubscriptionFromStripe(await readStripeSubscription(api, input.subscriptionId));
}
