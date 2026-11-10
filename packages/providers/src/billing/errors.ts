import type { BillingProviderId, BillingRefusal } from "./types";

export type BillingProviderErrorCode = "not_supported" | "not_found" | "already_ended" | "rate_limited" | "unavailable" | "refused";

/**
 * A billing provider's answer in neutral terms: what happened, and the
 * refusal to tell the business when asking again won't change it. An adapter
 * throws it for what its provider doesn't do (not_supported) and may wrap its
 * provider's own errors in it.
 */
export class BillingProviderError extends Error {
  constructor(
    readonly provider: BillingProviderId,
    readonly code: BillingProviderErrorCode,
    message: string,
    readonly refusal?: BillingRefusal,
  ) {
    super(message);
    this.name = "BillingProviderError";
  }
}

export type BillingWebhookRefusalReason = "unconfigured" | "missing_headers" | "bad_signature" | "too_old" | "wrong_mode" | "invalid_payload";

/** Why a delivery isn't taken: answered 401, or 400 for a body that isn't an event, and logged without its body. */
export class BillingWebhookRefusal extends Error {
  constructor(readonly provider: BillingProviderId, readonly reason: BillingWebhookRefusalReason) {
    super(`The ${provider} webhook refused a delivery: ${reason}.`);
    this.name = "BillingWebhookRefusal";
  }
}

export function isBillingProviderError(error: unknown, code?: BillingProviderErrorCode): error is BillingProviderError {
  return error instanceof BillingProviderError && (code === undefined || error.code === code);
}
