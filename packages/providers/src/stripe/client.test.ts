import { afterEach, describe, expect, it, vi } from "vitest";

import { STRIPE_API_VERSION } from "@lobbystack/shared";

import { checkStripeAccount, createStripeClient, stripeKeyEnv, stripeLocale } from "./client";
import { createFakeStripe } from "./fake";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the Stripe client", () => {
  it("reads a key's mode from its prefix", () => {
    expect(stripeKeyEnv("sk_test_abc123")).toBe("sandbox");
    expect(stripeKeyEnv("rk_test_abc123")).toBe("sandbox");
    expect(stripeKeyEnv(" rk_live_abc123 ")).toBe("live");
    expect(stripeKeyEnv("pk_test_abc123")).toBeNull();
    expect(stripeKeyEnv("whsec_abc123")).toBeNull();
  });

  it("sends a language Stripe's pages come in, and none for one they don't", () => {
    expect(stripeLocale("fr")).toBe("fr");
    expect(stripeLocale("fr-ca")).toBe("fr-CA");
    expect(stripeLocale("es_419")).toBe("es-419");
    expect(stripeLocale("es-MX")).toBe("es");
    expect(stripeLocale("EN")).toBe("en");
    expect(stripeLocale("sr")).toBeNull();
    expect(stripeLocale("sr-Latn")).toBeNull();
    expect(stripeLocale("")).toBeNull();
    expect(stripeLocale(null)).toBeNull();
  });

  it("pins the API version the stripe package was released with", () => {
    expect(STRIPE_API_VERSION).toBe("2026-10-28.endive");
    const client = createStripeClient("sk_test_abc123");
    expect(client.getApiField("version")).toBe(STRIPE_API_VERSION);
    expect(client.getMaxNetworkRetries()).toBe(2);
    expect(client.getApiField("timeout")).toBe(15_000);
  });

  it("takes test keys only in a certification run", () => {
    vi.stubEnv("LOBBYSTACK_CERTIFICATION_MODE", "true");
    expect(() => createStripeClient("sk_live_abc123")).toThrow("CERTIFICATION_REQUIRES_STRIPE_TEST_KEY");
    expect(() => createStripeClient("rk_live_abc123")).toThrow("CERTIFICATION_REQUIRES_STRIPE_TEST_KEY");
    expect(() => createStripeClient("rk_test_abc123")).not.toThrow();
  });

  it("refuses at startup a key of another account, or of the other mode", async () => {
    const stripe = createFakeStripe({ accountId: "acct_1" });
    await expect(checkStripeAccount(stripe, { key: "rk_test_abc123", accountId: "acct_1", env: "sandbox" })).resolves.toBeUndefined();
    await expect(checkStripeAccount(stripe, { key: "rk_test_abc123", accountId: "acct_2", env: "sandbox" })).rejects.toThrow("belongs to Stripe account acct_1, not STRIPE_ACCOUNT_ID acct_2");
    await expect(checkStripeAccount(stripe, { key: "rk_test_abc123", accountId: "acct_1", env: "live" })).rejects.toThrow("is a test key, and this deployment bills live");
    await expect(checkStripeAccount(stripe, { key: "rk_live_abc123", accountId: "acct_1", env: "sandbox" })).rejects.toThrow("is a live key, and this deployment bills in a sandbox");
    await expect(checkStripeAccount(stripe, { key: "pk_test_abc123", accountId: "acct_1", env: "sandbox" })).rejects.toThrow("isn't a Stripe secret or restricted key");
  });
});
