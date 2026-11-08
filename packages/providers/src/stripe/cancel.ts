import type { BillingProvider } from "../billing/types";
import type { StripeApi } from "./client";
import { stripeNotYet } from "./errors";

// Cancel at the renewal, resume, and keep my plan: step 15 of the Stripe plan.

export async function cancelStripePlan(_api: StripeApi, _input: Parameters<BillingProvider["cancel"]>[0]): ReturnType<BillingProvider["cancel"]> {
  throw stripeNotYet("cancel a plan", 15);
}

export async function resumeStripePlan(_api: StripeApi, _input: Parameters<BillingProvider["resume"]>[0]): ReturnType<BillingProvider["resume"]> {
  throw stripeNotYet("resume a plan", 15);
}

export async function keepStripePlan(_api: StripeApi, _input: Parameters<BillingProvider["keepPlan"]>[0]): ReturnType<BillingProvider["keepPlan"]> {
  throw stripeNotYet("keep a plan", 15);
}
