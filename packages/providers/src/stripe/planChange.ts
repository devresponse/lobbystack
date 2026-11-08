import type { BillingProvider } from "../billing/types";
import type { StripeApi } from "./client";
import { stripeNotYet } from "./errors";

// Upgrades with pending updates, schedules for downgrades and promo endings,
// and removing a discount: step 14 of the Stripe plan.

export async function changeStripePlan(_api: StripeApi, _input: Parameters<BillingProvider["changePlan"]>[0]): ReturnType<BillingProvider["changePlan"]> {
  throw stripeNotYet("change a plan", 14);
}

export async function endStripePlanAtRenewal(_api: StripeApi, _input: Parameters<BillingProvider["endAtRenewal"]>[0]): ReturnType<BillingProvider["endAtRenewal"]> {
  throw stripeNotYet("end a promo plan", 14);
}

export async function removeStripeDiscount(_api: StripeApi, _input: Parameters<BillingProvider["removeDiscount"]>[0]): ReturnType<BillingProvider["removeDiscount"]> {
  throw stripeNotYet("remove a discount", 14);
}
