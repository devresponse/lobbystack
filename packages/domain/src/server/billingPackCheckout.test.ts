import { describe, expect, it } from "vitest";

import { isPackCheckoutStatus, packCheckoutConfigured } from "./billingPackCheckout";

describe("whether a deployment can sell packs", () => {
  it("reads the provider the deployment uses: Polar's token and organization, or Stripe's key and account", () => {
    expect(packCheckoutConfigured({ POLAR_ACCESS_TOKEN: "polar-token", POLAR_ORGANIZATION_ID: "org" })).toBe(true);
    expect(packCheckoutConfigured({ BILLING_PROVIDER: "polar", POLAR_ACCESS_TOKEN: "polar-token" })).toBe(false);
    expect(packCheckoutConfigured({ BILLING_PROVIDER: "stripe", STRIPE_API_KEY: "sk_test_1", STRIPE_ACCOUNT_ID: "acct_1" })).toBe(true);
    // Polar's settings don't sell on a Stripe deployment, nor Stripe's on a Polar one.
    expect(packCheckoutConfigured({ BILLING_PROVIDER: "stripe", POLAR_ACCESS_TOKEN: "polar-token", POLAR_ORGANIZATION_ID: "org" })).toBe(false);
    expect(packCheckoutConfigured({ STRIPE_API_KEY: "sk_test_1", STRIPE_ACCOUNT_ID: "acct_1" })).toBe(false);
    expect(packCheckoutConfigured({ BILLING_PROVIDER: "stripe", STRIPE_API_KEY: " ", STRIPE_ACCOUNT_ID: "acct_1" })).toBe(false);
    expect(packCheckoutConfigured({})).toBe(false);
  });

  it("knows a checkout's statuses", () => {
    for (const status of ["pending", "processing", "ready", "paid", "failed", "expired"]) expect(isPackCheckoutStatus(status)).toBe(true);
    for (const status of ["error", "changed", "canceled", null, undefined]) expect(isPackCheckoutStatus(status)).toBe(false);
  });
});
