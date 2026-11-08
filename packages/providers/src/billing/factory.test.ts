import { describe, expect, it } from "vitest";

import { PolarBilling } from "../polar/adapter";
import { PolarCatalogClient } from "../polar/polarCatalog";
import { StripeBilling } from "../stripe/adapter";
import { createBillingCatalogClient, createBillingProvider, createBillingWebhook, readBillingProviderId } from "./factory";

const polar = { POLAR_ACCESS_TOKEN: "token", POLAR_ORGANIZATION_ID: "org-1" };

describe("the billing provider factory", () => {
  it("bills through Polar when BILLING_PROVIDER is unset or polar, and stops for anything else", () => {
    expect(readBillingProviderId({})).toBe("polar");
    expect(readBillingProviderId({ BILLING_PROVIDER: " Polar " })).toBe("polar");
    expect(() => readBillingProviderId({ BILLING_PROVIDER: "stripe" })).toThrow("isn't available yet");
    expect(() => readBillingProviderId({ BILLING_PROVIDER: "stripe", BILLING_STRIPE_PREVIEW: "false" })).toThrow("isn't available yet");
    expect(readBillingProviderId({ BILLING_PROVIDER: "stripe", BILLING_STRIPE_PREVIEW: "true" })).toBe("stripe");
    expect(() => readBillingProviderId({ BILLING_PROVIDER: "paddle" })).toThrow("must be polar or stripe");
  });

  it("builds the Polar provider from its token and organization, on production unless the base URL is the sandbox", () => {
    expect(createBillingProvider({})).toBeUndefined();
    expect(createBillingProvider({ POLAR_ACCESS_TOKEN: "token" })).toBeUndefined();
    const live = createBillingProvider(polar);
    expect(live).toBeInstanceOf(PolarBilling);
    expect(live).toMatchObject({ id: "polar", env: "live", account: "org-1" });
    expect(createBillingProvider({ ...polar, POLAR_API_BASE_URL: "https://sandbox-api.polar.sh/" })).toMatchObject({ env: "sandbox" });
    expect(() => createBillingProvider({ ...polar, BILLING_PROVIDER: "stripe" })).toThrow("isn't available yet");
  });

  it("builds Stripe behind BILLING_STRIPE_PREVIEW, with test keys only, and neither its webhook nor its catalog client yet", () => {
    const stripe = { BILLING_PROVIDER: "stripe", BILLING_STRIPE_PREVIEW: "true", STRIPE_ACCOUNT_ID: "acct_1" };
    expect(createBillingProvider(stripe)).toBeUndefined();
    const sandbox = createBillingProvider({ ...stripe, STRIPE_API_KEY: "rk_test_abc123" });
    expect(sandbox).toBeInstanceOf(StripeBilling);
    expect(sandbox).toMatchObject({ id: "stripe", env: "sandbox", account: "acct_1" });
    expect(() => createBillingProvider({ ...stripe, STRIPE_API_KEY: "rk_live_abc123" })).toThrow("test keys only");
    expect(() => createBillingProvider({ ...stripe, STRIPE_API_KEY: "pk_test_abc123" })).toThrow("secret or restricted key");
    expect(() => createBillingProvider({ BILLING_PROVIDER: "stripe", STRIPE_ACCOUNT_ID: "acct_1", STRIPE_API_KEY: "rk_test_abc123" })).toThrow("isn't available yet");
    expect(() => createBillingWebhook(stripe)).toThrow("step 12");
    // No catalog client until step 11, so the worker starts and skips the daily check.
    expect(createBillingCatalogClient(stripe, "rk_test_abc123")).toBeUndefined();
  });

  it("builds the daily check's catalog client with the worker's token, or the token it's given", () => {
    expect(createBillingCatalogClient({ POLAR_ACCESS_TOKEN: "token" })).toBeUndefined();
    expect(createBillingCatalogClient(polar)).toBeInstanceOf(PolarCatalogClient);
    expect(createBillingCatalogClient({}, "setup-token")).toBeInstanceOf(PolarCatalogClient);
  });
});
