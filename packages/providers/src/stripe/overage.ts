import type Stripe from "stripe";

import { stripeOverageMeterEvents } from "@lobbystack/shared";

import { BillingProviderError } from "../billing/errors";
import type { BillingProvider } from "../billing/types";
import type { StripeApi } from "./client";
import { isStripeAlreadyCanceled, isStripeMissing } from "./errors";

// The overage subscription (the Stripe plan's step 13): the three metered
// prices, anchored on the 1st at 00:00 UTC, so each month's overage is
// invoiced on its own whatever the plan's cycle, and paid with the customer's
// default card, which the plan's checkout sets.

const endedStates = new Set(["canceled", "incomplete_expired"]);

/**
 * Unpaid, or ended by Stripe after failed payments or a dispute with its last
 * invoice still open: the operator's to collect or forgive. One ended any
 * other way, such as with its plan, is replaced.
 */
function owing(subscription: Stripe.Subscription): boolean {
  if (subscription.status === "unpaid") return true;
  const reason = subscription.cancellation_details?.reason;
  if (!endedStates.has(subscription.status) || (reason !== "payment_failed" && reason !== "payment_disputed")) return false;
  const invoice = subscription.latest_invoice;
  return invoice !== null && (typeof invoice === "string" || invoice.status === "open");
}

/** The overage prices' lookup keys in a currency, as pnpm billing makes them. */
export const stripeOverageLookupKeys = (currency: string) => Object.values(stripeOverageMeterEvents).map((event) => `${event}_${currency}`);

/**
 * The plan subscription's overage subscription, made once: one a try that
 * died made is found again by its metadata, and one set to end with its month
 * is kept on. A customer has one at a time, whatever plan it came with: the
 * meters count by customer, so a second would bill the same usage again, as
 * when a business buys a plan again before the last one's overage month ends.
 * One that ended is replaced, unless one is owing (see owing). The checkout's
 * card moves from the plan subscription to the customer, so a card changed in
 * the portal pays for both.
 */
export async function ensureStripeOverage(api: StripeApi, input: Parameters<NonNullable<BillingProvider["ensureOverage"]>>[0]): ReturnType<NonNullable<BillingProvider["ensureOverage"]>> {
  if (input.onPlan) {
    // Sold on the plan's checkout, overage bills on the plan subscription, which must hold all three prices.
    const prices = await stripeOveragePrices(api, input.currency);
    const plan = await api.subscriptions.retrieve(input.planSubscriptionId);
    const held = new Set(plan.items.data.map((item) => item.price.id));
    const lacking = prices.filter((price) => !held.has(price));
    if (lacking.length) throw new BillingProviderError("stripe", "not_found", `The plan subscription ${plan.id} lacks ${lacking.length} of the overage prices its checkout sells (${lacking.join(", ")}), so its usage past the allowance can't be billed.`);
    return { subscriptionId: plan.id };
  }
  const subscriptions = await api.subscriptions.list({ customer: input.customerId, status: "all", limit: 100, expand: ["data.latest_invoice"] });
  const overages = subscriptions.data.filter((subscription) => subscription.metadata?.lobbystack_role === "overage");
  const unpaid = overages.find(owing);
  if (unpaid) return { unpaidSubscriptionId: unpaid.id };
  const plans = overages.filter((subscription) => subscription.metadata?.lobbystack_plan_subscription === input.planSubscriptionId);
  const live = overages.filter((subscription) => !endedStates.has(subscription.status));
  const found = live.find((subscription) => plans.includes(subscription)) ?? live[0];
  if (found) {
    // Stripe takes one of the two at a time; cancel_at_period_end sets cancel_at too.
    const end = found.cancel_at_period_end ? { cancel_at_period_end: false } : found.cancel_at ? { cancel_at: "" as const } : {};
    const moved = found.metadata?.lobbystack_plan_subscription !== input.planSubscriptionId ? { metadata: { lobbystack_plan_subscription: input.planSubscriptionId } } : {};
    if (Object.keys(end).length || Object.keys(moved).length) await api.subscriptions.update(found.id, { ...end, ...moved });
    return { subscriptionId: found.id };
  }
  const items = await stripeOveragePrices(api, input.currency);
  const plan = await api.subscriptions.retrieve(input.planSubscriptionId);
  const card = typeof plan.default_payment_method === "string" ? plan.default_payment_method : plan.default_payment_method?.id ?? null;
  if (card) await api.customers.update(input.customerId, { invoice_settings: { default_payment_method: card } });
  // The key counts the plan's overage subscriptions so far, so Stripe never answers a replacement with the one before.
  const made = await api.subscriptions.create({
    customer: input.customerId,
    items: items.map((price) => ({ price })),
    billing_cycle_anchor_config: { day_of_month: 1, hour: 0, minute: 0, second: 0 },
    proration_behavior: "none",
    automatic_tax: { enabled: true },
    metadata: { lobbystack_business: input.businessId, lobbystack_role: "overage", lobbystack_plan_subscription: input.planSubscriptionId },
  }, { idempotencyKey: `overage:${input.planSubscriptionId}:${plans.length}` });
  // Both subscriptions pay with the customer's default card from now on.
  if (card) await api.subscriptions.update(input.planSubscriptionId, { default_payment_method: "" });
  return { subscriptionId: made.id };
}

/** The three overage prices Stripe sells in the currency, by lookup key, or a refusal naming the ones missing. */
export async function stripeOveragePrices(api: StripeApi, currency: string): Promise<string[]> {
  const lookupKeys = stripeOverageLookupKeys(currency);
  const prices = await api.prices.list({ lookup_keys: lookupKeys, active: true, limit: 10 });
  const found = lookupKeys.map((key) => prices.data.find((price) => price.lookup_key === key)).filter((price) => price !== undefined);
  if (found.length !== lookupKeys.length) throw new BillingProviderError("stripe", "not_found", `Stripe sells ${found.length} of the ${lookupKeys.length} overage prices (${lookupKeys.join(", ")}). Run pnpm billing apply --stripe.`);
  return found.map((price) => price.id);
}

/**
 * Ends the overage subscription at its month's end, invoicing the month, or
 * now with its last invoice, as for a business being deleted. One that ended
 * already, or that Stripe no longer has, is ended.
 */
export async function endStripeOverage(api: StripeApi, input: Parameters<NonNullable<BillingProvider["endOverage"]>>[0]): Promise<void> {
  try {
    if (input.when === "now") await api.subscriptions.cancel(input.subscriptionId, { invoice_now: true, prorate: false }, { idempotencyKey: `overage-end:${input.subscriptionId}` });
    else await api.subscriptions.update(input.subscriptionId, { cancel_at_period_end: true });
  } catch (error) {
    if (isStripeMissing(error) || isStripeAlreadyCanceled(error)) return;
    throw error;
  }
}
