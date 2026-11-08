import type { BillingProvider } from "../billing/types";
import type { StripeApi } from "./client";
import { stripeNotYet } from "./errors";

// Checkout Sessions for the plan subscription: step 13 of the Stripe plan.

export async function createStripeCheckout(_api: StripeApi, _input: Parameters<BillingProvider["createCheckout"]>[0]): ReturnType<BillingProvider["createCheckout"]> {
  throw stripeNotYet("make a checkout", 13);
}
