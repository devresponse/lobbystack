import type { BillingProvider } from "../billing/types";
import type { StripeApi } from "./client";
import { stripeNotYet } from "./errors";

// Meter events, meter event summaries, the overage invoice's lines and the
// customer credit the daily totals check gives: step 16 of the Stripe plan.

export async function reportStripeUsage(_api: StripeApi, _input: Parameters<BillingProvider["reportUsage"]>[0]): ReturnType<BillingProvider["reportUsage"]> {
  throw stripeNotYet("send usage", 16);
}

export async function stripeUsageTotals(_api: StripeApi, _input: Parameters<NonNullable<BillingProvider["usageTotals"]>>[0]): ReturnType<NonNullable<BillingProvider["usageTotals"]>> {
  throw stripeNotYet("read usage totals", 16);
}

export async function stripeInvoicedOverage(_api: StripeApi, _input: Parameters<NonNullable<BillingProvider["invoicedOverage"]>>[0]): ReturnType<NonNullable<BillingProvider["invoicedOverage"]>> {
  throw stripeNotYet("read an overage invoice", 16);
}

export async function creditStripeBalance(_api: StripeApi, _input: Parameters<NonNullable<BillingProvider["creditBalance"]>>[0]): Promise<void> {
  throw stripeNotYet("credit a customer", 16);
}
