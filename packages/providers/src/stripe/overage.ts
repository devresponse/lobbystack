import type { BillingProvider } from "../billing/types";
import type { StripeApi } from "./client";
import { stripeNotYet } from "./errors";

// The overage subscription, anchored on the 1st: step 13 of the Stripe plan.

export async function ensureStripeOverage(_api: StripeApi, _input: Parameters<NonNullable<BillingProvider["ensureOverage"]>>[0]): Promise<{ subscriptionId: string }> {
  throw stripeNotYet("make the overage subscription", 13);
}

export async function endStripeOverage(_api: StripeApi, _input: Parameters<NonNullable<BillingProvider["endOverage"]>>[0]): Promise<void> {
  throw stripeNotYet("end the overage subscription", 13);
}
