import type { BillingWebhook, NormalizedBillingEvent, VerifiedDelivery } from "../billing/types";
import { stripeNotYet } from "./errors";

// Stripe's webhook: the signature with two secrets during a rotation, the
// event allowlist, business hints and normalized events. Step 12 of the
// Stripe plan; the factory makes none before it.

export class StripeWebhook implements BillingWebhook {
  readonly provider = "stripe" as const;

  verify(): VerifiedDelivery {
    throw stripeNotYet("check a webhook delivery", 12);
  }

  normalize(): NormalizedBillingEvent | null {
    throw stripeNotYet("read a webhook event", 12);
  }
}
