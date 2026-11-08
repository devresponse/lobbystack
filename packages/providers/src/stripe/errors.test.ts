import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { isStripeAlreadyCanceled, isStripeMissing, stripeNotYet, stripeRefusalFor } from "./errors";

const invalid = (message: string, extra: { code?: string; param?: string } = {}) => new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message, ...extra });

describe("Stripe's errors in neutral terms", () => {
  it.each([
    [new Stripe.errors.StripeCardError({ type: "card_error", code: "card_declined", message: "Your card was declined." }), "payment_failed"],
    [new Stripe.errors.StripeCardError({ type: "card_error", code: "insufficient_funds", message: "Your card has insufficient funds." }), "payment_failed"],
    [invalid("No such subscription: 'sub_1'", { code: "resource_missing", param: "id" }), "subscription_unavailable"],
    [invalid("No such price: 'price_1'", { code: "resource_missing", param: "items[0][price]" }), "product_unavailable"],
    [invalid("The price specified is inactive. This field only accepts active prices.", { param: "items[0][price]" }), "product_unavailable"],
    [invalid("Archived products can't be added to a subscription."), "product_unavailable"],
    // The words in different sentences say something else.
    [invalid("This price can't be used here. The account is inactive."), undefined],
    [invalid("A canceled subscription can only update its cancellation_details and metadata."), "subscription_ending"],
    [invalid("The subscription is managed by the subscription schedule `sub_sched_1`, and updating any cancelation behavior directly is not allowed."), "change_pending"],
    [new Stripe.errors.StripePermissionError({ type: "invalid_request_error", message: "The provided key does not have the required permissions for this endpoint." }), "token_scope"],
    [new Stripe.errors.StripeAuthenticationError({ type: "authentication_error", message: "Invalid API Key provided." }), "token_scope"],
    [new Stripe.errors.StripeRateLimitError({ type: "rate_limit_error", message: "Too many requests." }), "retry"],
    [invalid("This object cannot be accessed right now because another API request or Stripe process is currently accessing it.", { code: "lock_timeout" }), "retry"],
    [new Stripe.errors.StripeAPIError({ type: "api_error", message: "An unknown error occurred." }), "retry"],
    [new Stripe.errors.StripeConnectionError({ type: "api_error", message: "An error occurred with our connection to Stripe." }), "retry"],
    // A key sent again with another body is a bug: thrown, never retried.
    [new Stripe.errors.StripeIdempotencyError({ type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters." }), undefined],
    [invalid("Received unknown parameter: frobnicate", { param: "frobnicate" }), undefined],
    [new Error("socket hang up"), undefined],
  ] as const)("answers %s with %s", (error, refusal) => {
    expect(stripeRefusalFor(error)).toBe(refusal);
  });

  it("tells a missing object and an ended subscription apart", () => {
    expect(isStripeMissing(invalid("No such subscription: 'sub_1'", { code: "resource_missing" }))).toBe(true);
    expect(isStripeMissing(invalid("This subscription has already been canceled."))).toBe(false);
    expect(isStripeAlreadyCanceled(invalid("This subscription has already been canceled."))).toBe(true);
    expect(isStripeAlreadyCanceled(new Error("This subscription has already been canceled."))).toBe(false);
  });

  it("says which step brings what isn't there yet", () => {
    expect(stripeNotYet("make a checkout", 13)).toMatchObject({ provider: "stripe", code: "not_supported", message: "Stripe billing can't make a checkout yet: step 13 of the Stripe plan adds it." });
  });
});
