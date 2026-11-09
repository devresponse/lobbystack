import Stripe from "stripe";

import { stripeOverageMeterEvents } from "@lobbystack/shared";

import { BillingProviderError } from "../billing/errors";
import type { BillingProvider, OverageKind } from "../billing/types";
import type { StripeApi } from "./client";

// Usage as money (the Stripe plan's step 16): one meter event per send,
// valued in dollars, and what the daily totals check reads back, the meters'
// totals for a customer and the credits it gave for corrections a month
// couldn't take.

const overageKinds = Object.keys(stripeOverageMeterEvents) as OverageKind[];

/** Cents with four decimals as the dollars a money meter sums, to six decimals. */
function dollars(cents: number): string {
  return (cents / 100).toFixed(6);
}

/** A meter event whose identifier Stripe already has: the same usage, sent again. */
function isDuplicateMeterEvent(error: unknown): boolean {
  if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) return false;
  const message = error.message.toLowerCase();
  return error.code === "resource_already_exists" || (message.includes("identifier") && message.includes("already"));
}

/** Sends one usage event to its kind's meter: the customer, the value in dollars, the identifier, and when it happened. */
export async function reportStripeUsage(api: StripeApi, input: Parameters<BillingProvider["reportUsage"]>[0]): ReturnType<BillingProvider["reportUsage"]> {
  if (!input.customer.id) throw new BillingProviderError("stripe", "not_found", "Usage needs the business's Stripe customer, which its checkout makes.");
  if (input.amountCents === null) throw new BillingProviderError("stripe", "refused", "Stripe's overage meters take usage priced in money.");
  try {
    await api.billing.meterEvents.create({
      event_name: stripeOverageMeterEvents[input.kind],
      payload: { stripe_customer_id: input.customer.id, value: dollars(input.amountCents) },
      identifier: input.identifier,
      timestamp: Math.floor(input.occurredAt.getTime() / 1000),
    });
    return "sent";
  } catch (error) {
    if (isDuplicateMeterEvent(error)) return "duplicate";
    throw error;
  }
}

/** The meters' IDs by overage kind, from their event names. */
async function overageMeters(api: StripeApi): Promise<Record<OverageKind, string>> {
  const meters = await api.billing.meters.list({ status: "active", limit: 100 }).autoPagingToArray({ limit: 100 });
  const ids = {} as Record<OverageKind, string>;
  for (const kind of overageKinds) {
    const meter = meters.find((entry) => entry.event_name === stripeOverageMeterEvents[kind]);
    if (!meter) throw new BillingProviderError("stripe", "not_found", `Stripe has no active meter for ${stripeOverageMeterEvents[kind]}. Run pnpm billing apply --stripe.`);
    ids[kind] = meter.id;
  }
  return ids;
}

/** Minutes, as Stripe takes a summary's start and end. */
const minute = (at: Date) => Math.floor(at.getTime() / 60_000) * 60;

/** What each meter holds for the customer from `from` to `to`, in cents: every event Stripe took, corrections included. */
export async function stripeUsageTotals(api: StripeApi, input: Parameters<NonNullable<BillingProvider["usageTotals"]>>[0]): ReturnType<NonNullable<BillingProvider["usageTotals"]>> {
  const meters = await overageMeters(api);
  const totals = {} as Record<OverageKind, number>;
  for (const kind of overageKinds) {
    const summaries = await api.billing.meters.listEventSummaries(meters[kind], { customer: input.customerId, start_time: minute(input.from), end_time: minute(input.to) }).autoPagingToArray({ limit: 1000 });
    totals[kind] = Math.round(summaries.reduce((sum, summary) => sum + summary.aggregated_value, 0) * 100 * 10_000) / 10_000;
  }
  return totals;
}

/** What the customer's balance was credited for overage corrections, in cents by kind. */
export async function stripeUsageCredits(api: StripeApi, input: Parameters<NonNullable<BillingProvider["usageCredits"]>>[0]): ReturnType<NonNullable<BillingProvider["usageCredits"]>> {
  const transactions = await api.customers.listBalanceTransactions(input.customerId, { limit: 100 }).autoPagingToArray({ limit: 10_000 });
  const credits = Object.fromEntries(overageKinds.map((kind) => [kind, 0])) as Record<OverageKind, number>;
  for (const transaction of transactions) {
    const kind = transaction.metadata?.lobbystack_overage as OverageKind | undefined;
    if (transaction.metadata?.lobbystack_role === "usage_credit" && kind && Object.hasOwn(credits, kind)) credits[kind] -= transaction.amount;
  }
  return credits;
}

/**
 * Credits the customer's balance for a correction a month's overage can't
 * take, since Stripe bills a negative month as zero. Stripe applies it to the
 * next invoice. The identifier keys it, so a retried check credits once.
 */
export async function creditStripeBalance(api: StripeApi, input: Parameters<NonNullable<BillingProvider["creditBalance"]>>[0]): Promise<void> {
  await api.customers.createBalanceTransaction(input.customerId, {
    amount: -Math.round(input.cents),
    currency: input.currency,
    description: "Overage usage corrected after its month",
    metadata: { lobbystack_role: "usage_credit", lobbystack_overage: input.kind },
  }, { idempotencyKey: input.identifier });
}
