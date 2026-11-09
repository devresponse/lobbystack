import Stripe from "stripe";

// Stripe's own error classes, as the fake throws them.

/** No object by that ID: Stripe's resource_missing. */
export function missing(kind: string, id: string, param = "id"): Stripe.errors.StripeInvalidRequestError {
  return new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", code: "resource_missing", message: `No such ${kind}: '${id}'`, param });
}

/** A request Stripe refuses, with its message. */
export function invalid(message: string, param?: string): Stripe.errors.StripeInvalidRequestError {
  return new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message, ...(param ? { param } : {}) });
}

/** A restricted key without the permission the call needs, which a test throws from a call it spies on. */
export function permissionDenied(): Stripe.errors.StripePermissionError {
  return new Stripe.errors.StripePermissionError({ type: "invalid_request_error", message: "The provided key does not have the required permissions for this endpoint. Having the 'rak_subscription_write' permission would allow this request to continue." });
}

/** A card the issuer declines. */
export function declined(): Stripe.errors.StripeCardError {
  return new Stripe.errors.StripeCardError({ type: "card_error", code: "card_declined", decline_code: "generic_decline", message: "Your card was declined." });
}

/** An idempotency key sent again with another body: a bug in the caller. */
export function idempotencyMismatch(key: string): Stripe.errors.StripeIdempotencyError {
  return new Stripe.errors.StripeIdempotencyError({ type: "idempotency_error", message: `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${key}' if you meant to execute a different request.` });
}
