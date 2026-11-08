import type Stripe from "stripe";

import type { BillingProvider, ProviderSubscription } from "../billing/types";
import type { StripeApi } from "./client";
import { isStripeAlreadyCanceled, isStripeMissing } from "./errors";
import { providerSubscriptionFromStripe } from "./subscriptions";

// Cancelling at the renewal, resuming, and keeping the plan (the Stripe
// plan's step 15), which Settings > Plan offers on Stripe. Each is keyed by
// its request, so a retried job asks Stripe once.

const idOf = (value: string | { id: string } | null | undefined) => (typeof value === "string" ? value : value?.id ?? null);

async function readStripeSubscription(api: StripeApi, id: string): Promise<Stripe.Subscription> {
  return await api.subscriptions.retrieve(id, { expand: ["schedule", "discounts", "latest_invoice"] });
}

/**
 * Ends the plan at its renewal, after releasing a schedule whose next phase
 * would undo the end, or now. Null once it has ended.
 */
export async function cancelStripePlan(api: StripeApi, input: Parameters<BillingProvider["cancel"]>[0]): ReturnType<BillingProvider["cancel"]> {
  if (input.when === "now") {
    try {
      await api.subscriptions.cancel(input.subscriptionId, {}, { idempotencyKey: `cancel:${input.requestId}` });
    } catch (error) {
      if (!isStripeMissing(error) && !isStripeAlreadyCanceled(error)) throw error;
    }
    return null;
  }
  const subscription = await readStripeSubscription(api, input.subscriptionId);
  const schedule = idOf(subscription.schedule);
  if (schedule) await api.subscriptionSchedules.release(schedule, {}, { idempotencyKey: `cancel:${input.requestId}:release` });
  if (!subscription.cancel_at_period_end) await api.subscriptions.update(subscription.id, { cancel_at_period_end: true }, { idempotencyKey: `cancel:${input.requestId}` });
  return providerSubscriptionFromStripe(await readStripeSubscription(api, subscription.id));
}

/** Undoes an end at the renewal, while the period lasts: the plan renews again. */
export async function resumeStripePlan(api: StripeApi, input: Parameters<BillingProvider["resume"]>[0]): ReturnType<BillingProvider["resume"]> {
  const subscription = await readStripeSubscription(api, input.subscriptionId);
  // Stripe takes one of the two at a time: the end set at the period's end, or one set for a date.
  const params: Stripe.SubscriptionUpdateParams | null = subscription.cancel_at_period_end ? { cancel_at_period_end: false } : subscription.cancel_at ? { cancel_at: "" } : null;
  if (params) await api.subscriptions.update(subscription.id, params, { idempotencyKey: `resume:${input.requestId}` });
  return providerSubscriptionFromStripe(await readStripeSubscription(api, subscription.id));
}

/** Drops a change waiting for the renewal by releasing its schedule: the subscription stays on its price. */
export async function keepStripePlan(api: StripeApi, input: Parameters<BillingProvider["keepPlan"]>[0]): Promise<ProviderSubscription> {
  const subscription = await readStripeSubscription(api, input.subscriptionId);
  const schedule = idOf(subscription.schedule);
  if (schedule) await api.subscriptionSchedules.release(schedule, {}, { idempotencyKey: `keep:${input.requestId}` });
  return providerSubscriptionFromStripe(await readStripeSubscription(api, subscription.id));
}
