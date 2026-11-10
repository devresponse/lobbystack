import Stripe from "stripe";

import { BillingProviderError } from "../billing/errors";
import type { BillingRefusal } from "../billing/types";

// Stripe's errors in neutral terms, per the Errors table of the Stripe plan's
// technical proposal. Stripe types most errors and codes some; the rest are
// told apart by the message Stripe sends, which the sandbox runs of the later
// steps check.

/** A Stripe object that doesn't exist, as for a subscription Stripe no longer has. */
export function isStripeMissing(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeInvalidRequestError && error.code === "resource_missing";
}

/** Stripe's refusal to cancel a subscription that already ended. */
export function isStripeAlreadyCanceled(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeInvalidRequestError && /already (?:been )?cancell?ed|subscription is cancell?ed|cancell?ed subscription/i.test(error.message);
}

/**
 * The refusal to tell the business for Stripe's error, "retry" when the same
 * call may pass later, or undefined for an error that is a bug, such as an
 * idempotency key sent again with another body, or that isn't Stripe's.
 */
export function stripeRefusalFor(error: unknown): BillingRefusal | undefined {
  if (!(error instanceof Stripe.errors.StripeError)) return undefined;
  if (error instanceof Stripe.errors.StripeIdempotencyError) return undefined;
  if (error instanceof Stripe.errors.StripeCardError) return "payment_failed";
  // A restricted key missing a permission, or a key Stripe doesn't take.
  if (error instanceof Stripe.errors.StripePermissionError || error instanceof Stripe.errors.StripeAuthenticationError) return "token_scope";
  if (error instanceof Stripe.errors.StripeRateLimitError || error instanceof Stripe.errors.StripeAPIError || error instanceof Stripe.errors.StripeConnectionError) return "retry";
  if (error.code === "lock_timeout" || error.code === "rate_limit" || error.code === "idempotency_key_in_use") return "retry";
  if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) return undefined;
  const message = error.message;
  if (error.code === "resource_missing") return /price|product/i.test(error.param ?? "") ? "product_unavailable" : "subscription_unavailable";
  // A price or product and "inactive" or "archived" in one sentence. Split
  // first: a regex with [^.]* between the words backtracks, which takes
  // seconds on a long message.
  const sentences = message.toLowerCase().split(".");
  if (sentences.some((sentence) => (sentence.includes("price") || sentence.includes("product")) && (sentence.includes("inactive") || sentence.includes("archived")))) return "product_unavailable";
  // A schedule holds the subscription, or a pending update waits for payment.
  if (/subscription schedule|pending update/i.test(message)) return "change_pending";
  if (/cancell?ed|cancel_at|set to cancel/i.test(message)) return "subscription_ending";
  return undefined;
}

/** What a later step of the Stripe plan adds: until then the adapter answers not_supported. */
export function stripeNotYet(what: string, step: number): BillingProviderError {
  return new BillingProviderError("stripe", "not_supported", `Stripe billing can't ${what} yet: step ${step} of the Stripe plan adds it.`);
}
