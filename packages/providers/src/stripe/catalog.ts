import type { BillingCatalogClient } from "../billing/types";
import { stripeNotYet } from "./errors";

// The catalog client pnpm billing runs on Stripe: reads products, prices by
// lookup key, meters, coupons, portal configurations and webhook endpoints,
// and runs a plan's steps with idempotency keys. Step 11 of the Stripe plan.

export class StripeCatalogClient implements BillingCatalogClient<never, never> {
  readonly provider = "stripe" as const;

  async readSnapshot(): Promise<never> {
    throw stripeNotYet("read the catalog", 11);
  }

  async run(): Promise<{ webhookSecret: string | null }> {
    throw stripeNotYet("set the catalog up", 11);
  }
}
