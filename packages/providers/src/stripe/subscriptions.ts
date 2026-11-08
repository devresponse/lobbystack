import type Stripe from "stripe";

import type { ProviderSubscription } from "../billing/types";

// A Stripe subscription read into the interface's terms (the Stripe plan's
// "Reading a subscription" table). The plan's item is the one whose price is
// a plan price, never an overage price; recent API versions keep the period
// dates on items, not on the subscription.

const states: Record<string, ProviderSubscription["state"]> = {
  incomplete: "incomplete",
  incomplete_expired: "ended",
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "unpaid",
  paused: "paused",
  canceled: "canceled",
};

const intervals: Record<string, ProviderSubscription["interval"]> = { month: "monthly", year: "annual" };

const time = (seconds: number | null | undefined) => (typeof seconds === "number" ? new Date(seconds * 1000) : null);
const idOf = (value: string | { id: string } | null | undefined) => (typeof value === "string" ? value : value?.id ?? null);

/** A metered overage price, which the overage subscription bills; a plan's price is licensed. */
export function isStripeOveragePrice(price: Pick<Stripe.Price, "recurring" | "metadata">): boolean {
  return price.recurring?.usage_type === "metered" || price.metadata?.lobbystack_role === "overage";
}

/** The plan's item: the one whose price is a plan price. */
export function stripePlanItem(subscription: Pick<Stripe.Subscription, "items">): Stripe.SubscriptionItem | null {
  return subscription.items.data.find((item) => !isStripeOveragePrice(item.price)) ?? null;
}

/** The coupon of an expanded discount; an unexpanded one names none. */
function couponOf(discount: string | Stripe.Discount): string | null {
  return typeof discount === "string" ? null : idOf(discount.source?.coupon ?? null);
}

/** The schedule's next phase, when it moves the plan's item to another price. */
function nextPhase(subscription: Stripe.Subscription, planPrice: string | null, readAt: Date): ProviderSubscription["next"] {
  const schedule = typeof subscription.schedule === "object" ? subscription.schedule : null;
  if (!schedule) return null;
  const now = readAt.getTime() / 1000;
  const phase = schedule.phases.find((entry) => entry.start_date > now);
  const price = phase?.items.map((item) => idOf(item.price)).find((ref) => ref !== null) ?? null;
  return phase && price && price !== planPrice ? { priceRef: price, at: time(phase.start_date)! } : null;
}

/** A subscription as the interface shows one. readAt orders read-backs, so a late one never undoes a newer one. */
export function providerSubscriptionFromStripe(subscription: Stripe.Subscription, readAt = new Date()): ProviderSubscription {
  const item = stripePlanItem(subscription);
  const priceRef = item?.price.id ?? null;
  const periodEnd = time(item?.current_period_end);
  const invoice = typeof subscription.latest_invoice === "object" ? subscription.latest_invoice : null;
  return {
    id: subscription.id,
    customerId: idOf(subscription.customer),
    state: states[subscription.status] ?? "ended",
    priceRef,
    interval: item?.price.recurring ? intervals[item.price.recurring.interval] ?? null : null,
    discountRef: subscription.discounts.map(couponOf).find((coupon) => coupon !== null) ?? null,
    periodStart: time(item?.current_period_start),
    periodEnd,
    // Stripe ends a subscription at cancel_at, or at the period's end when it was set to cancel then.
    cancelAt: time(subscription.cancel_at) ?? (subscription.cancel_at_period_end ? periodEnd ?? readAt : null),
    endedAt: time(subscription.ended_at),
    next: nextPhase(subscription, priceRef, readAt),
    // An upgrade waiting for its payment, with the invoice's page when the payment needs the customer.
    pendingPayment: subscription.pending_update ? { url: invoice?.hosted_invoice_url ?? null, expiresAt: time(subscription.pending_update.expires_at)! } : null,
    metadata: { ...subscription.metadata },
    readAt,
  };
}
