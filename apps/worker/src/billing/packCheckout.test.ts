import { randomUUID } from "node:crypto";

import type { JobEnvelope } from "@lobbystack/contracts";
import { claimPackCheckout, loadPackCheckoutRequest, loadStripeSelling, markPackCheckoutFailed, markPackCheckoutReady, releasePackCheckout, type PackCheckoutWork } from "@lobbystack/domain";
import { PolarRequestError } from "@lobbystack/providers/polar/polarBilling";
import type { PolarBillingClient } from "@lobbystack/providers/polar/adapter";
import type { StripeCatalogPrice } from "@lobbystack/providers/stripe/catalog";
import { StripeBilling } from "@lobbystack/providers/stripe/adapter";
import { createFakeStripe, FakeClock } from "@lobbystack/providers/stripe/fake";
import { planChangeRefusals } from "@lobbystack/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lobbystack/shared", async (importOriginal) => (await import("./testing")).mockShared(importOriginal));
vi.mock("@lobbystack/domain", async (importOriginal) => (await import("./testing")).mockDomain(importOriginal));

import { handleJob, type WorkerDependencies } from "../handlers";
import { polarFake } from "./polarFake";

// billing.createPackCheckout: the page where a business pays once for a
// prepaid pack, on the deployment's provider, recorded on the pack checkout.

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const domain = { db: undefined as never };

function packJob(checkoutId: string, businessId = randomUUID()): JobEnvelope {
  return { jobId: randomUUID(), type: "billing.createPackCheckout", queue: "critical", businessId, payload: { checkoutId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
}

function work(job: JobEnvelope, input: Partial<PackCheckoutWork> = {}): PackCheckoutWork {
  const businessId = job.businessId!;
  return { id: String(job.payload.checkoutId), businessId, pack: "minutes_500_90", priceId: "price-row-1", status: "processing", priceRef: "price_pack_500_90", customerEmail: "owner@example.com", billingEmail: null, externalCustomerId: `business:${businessId}`, customerId: null, businessName: "Allo Salon", onboardingStage: "complete", ...input };
}

/** The deployment's Stripe account, selling the pack at its one-time price. */
function stripeAccount(businessId: string) {
  const stripe = createFakeStripe({ accountId: "acct_1", clock: new FakeClock(Math.floor(Date.now() / 1000)) });
  stripe.addCustomer({ id: "cus_1", businessId });
  const price: StripeCatalogPrice = { id: "price_pack_500_90", active: true, product: "prod_pack", currency: "cad", unit_amount: 9900, lookup_key: "ls_pack_minutes_500_90_cad", tax_behavior: "exclusive", recurring: null, metadata: {}, created: 1 };
  stripe.loadCatalog({ products: [{ id: "prod_pack", name: "500 minutes for 90 days", active: true, metadata: {}, tax_code: "txcd_10103001", created: 1 }], prices: [price] });
  return { stripe, billing: new StripeBilling(stripe, { accountId: "acct_1", env: "sandbox" }) };
}

describe("billing jobs: a pack's checkout", () => {
  it("makes a Stripe payment page on the business's own customer, and records it in one step", async () => {
    vi.stubEnv("APP_BASE_URL", "https://app.example/");
    const checkoutId = randomUUID();
    const job = packJob(checkoutId);
    const businessId = job.businessId!;
    const { stripe, billing } = stripeAccount(businessId);
    vi.mocked(claimPackCheckout).mockResolvedValue({ claimed: true });
    vi.mocked(loadPackCheckoutRequest).mockResolvedValue(work(job, { customerId: "cus_1" }));
    vi.mocked(markPackCheckoutReady).mockResolvedValue(true);

    expect(await handleJob(job, { domain, billing })).toEqual({ status: "completed", entityId: checkoutId });

    const [session] = [...stripe.state.checkoutSessions.values()];
    expect(session).toMatchObject({ mode: "payment", customer: "cus_1", client_reference_id: checkoutId });
    // The pack and its price ride on the session and on the payment it makes.
    const tagged = { lobbystack_business: businessId, lobbystack_pack: "minutes_500_90", lobbystack_pack_price: "price-row-1", lobbystack_pack_checkout: checkoutId, lobbystack_role: "pack" };
    expect(session!.metadata).toEqual(tagged);
    expect(stripe.requests.at(-1)?.params).toMatchObject({ line_items: [{ price: "price_pack_500_90", quantity: 1 }], payment_intent_data: { metadata: tagged }, automatic_tax: { enabled: true }, invoice_creation: { enabled: true, invoice_data: { metadata: tagged } }, success_url: `https://app.example/settings/plan?pack=success&packCheckoutId=${checkoutId}`, cancel_url: "https://app.example/settings/plan" });
    expect(markPackCheckoutReady).toHaveBeenCalledExactlyOnceWith(domain, { businessId, checkoutId, providerCheckoutId: session!.id, checkoutUrl: session!.url, expiresAt: new Date(session!.expires_at * 1000) });
    expect(loadStripeSelling).toHaveBeenCalledWith(domain);
    expect(markPackCheckoutFailed).not.toHaveBeenCalled();
  });

  it("sells through Stripe's Managed Payments when the brand's stripe block makes Stripe the merchant of record", async () => {
    const checkoutId = randomUUID();
    const job = packJob(checkoutId);
    const { stripe, billing } = stripeAccount(job.businessId!);
    vi.mocked(claimPackCheckout).mockResolvedValue({ claimed: true });
    vi.mocked(loadPackCheckoutRequest).mockResolvedValue(work(job, { customerId: "cus_1" }));
    vi.mocked(loadStripeSelling).mockResolvedValueOnce({ managedPayments: true, overage: "separate", currency: "cad", usageGraceHours: 1 });

    expect(await handleJob(job, { domain, billing })).toEqual({ status: "completed", entityId: checkoutId });
    const params = stripe.requests.at(-1)?.params as Record<string, unknown>;
    expect(params.managed_payments).toEqual({ enabled: true });
    expect(params).not.toHaveProperty("automatic_tax");
    expect(params).not.toHaveProperty("invoice_creation");
  });

  it("makes a Polar checkout for the pack's product, out to a new customer with the billing email given, back to onboarding before it's done", async () => {
    vi.stubEnv("APP_BASE_URL", "https://app.example");
    const checkoutId = randomUUID();
    const job = packJob(checkoutId);
    const businessId = job.businessId!;
    vi.mocked(claimPackCheckout).mockResolvedValue({ claimed: true });
    vi.mocked(loadPackCheckoutRequest).mockResolvedValue(work(job, { priceRef: "product-pack-500-90", billingEmail: "billing@example.com", onboardingStage: "plan" }));
    const createCustomer = vi.fn().mockResolvedValue({ id: "customer-2", externalId: `business:${businessId}` });
    const createCheckout = vi.fn().mockResolvedValue({ checkoutId: "checkout-1", checkoutUrl: "https://polar.example/checkout-1" });

    expect(await handleJob(job, { domain, billing: polarFake({ findCustomerByExternalId: vi.fn().mockResolvedValue(null), createCustomer, createCheckout }) })).toEqual({ status: "completed", entityId: checkoutId });
    expect(createCustomer).toHaveBeenCalledWith({ externalId: `business:${businessId}`, email: "billing@example.com", name: "Allo Salon" });
    expect(createCheckout).toHaveBeenCalledExactlyOnceWith({
      productId: "product-pack-500-90",
      customer: { id: "customer-2" },
      metadata: { lobbystack_business: businessId, lobbystack_pack: "minutes_500_90", lobbystack_pack_price: "price-row-1", lobbystack_pack_checkout: checkoutId, lobbystack_role: "pack" },
      successUrl: `https://app.example/onboarding/plan?pack=success&packCheckoutId=${checkoutId}`,
      returnUrl: "https://app.example/onboarding/plan",
    });
    // Polar names no expiry, so the checkout gets the hour its page lasts.
    expect(markPackCheckoutReady).toHaveBeenCalledExactlyOnceWith(domain, { businessId, checkoutId, providerCheckoutId: "checkout-1", checkoutUrl: "https://polar.example/checkout-1", expiresAt: null });
    expect(loadStripeSelling).not.toHaveBeenCalled();
  });

  it("fails a checkout without a provider, and one whose pack stopped selling, without asking a provider", async () => {
    const createCheckout = vi.fn();
    vi.mocked(claimPackCheckout).mockResolvedValue({ claimed: true });
    const unconfigured = packJob(randomUUID());
    expect(await handleJob(unconfigured, { domain })).toEqual({ status: "skipped", entityId: unconfigured.payload.checkoutId });
    expect(markPackCheckoutFailed).toHaveBeenCalledWith(domain, { businessId: unconfigured.businessId, checkoutId: unconfigured.payload.checkoutId, error: "Billing checkout provider is not configured." });
    expect(loadPackCheckoutRequest).not.toHaveBeenCalled();

    const retired = packJob(randomUUID());
    vi.mocked(loadPackCheckoutRequest).mockResolvedValue(work(retired, { priceRef: null }));
    expect(await handleJob(retired, { domain, billing: polarFake({ createCheckout }) })).toEqual({ status: "skipped", entityId: retired.payload.checkoutId });
    expect(markPackCheckoutFailed).toHaveBeenLastCalledWith(domain, { businessId: retired.businessId, checkoutId: retired.payload.checkoutId, error: "This pack isn't on sale right now." });
    expect(createCheckout).not.toHaveBeenCalled();
    expect(markPackCheckoutReady).not.toHaveBeenCalled();
  });

  it("waits for a checkout another run holds, skips one that is done or gone, and reports one that waited too long", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const checkoutId = randomUUID();
    const job = packJob(checkoutId);
    const retryAt = new Date("2026-11-09T12:05:00Z");
    const createCheckout = vi.fn();
    const dependencies: WorkerDependencies = { domain, billing: polarFake({ createCheckout }) };
    vi.mocked(claimPackCheckout)
      .mockResolvedValueOnce({ claimed: false, retryAt })
      .mockResolvedValueOnce({ claimed: false, retryAt: null })
      .mockResolvedValueOnce({ claimed: false, retryAt: null, expired: true })
      .mockResolvedValueOnce({ claimed: true });
    vi.mocked(loadPackCheckoutRequest).mockResolvedValueOnce(null);

    expect(await handleJob(job, dependencies)).toEqual({ status: "deferred", entityId: checkoutId, retryAt });
    expect(await handleJob(job, dependencies)).toEqual({ status: "skipped", entityId: checkoutId });
    expect(error).not.toHaveBeenCalled();
    // The claim expired a checkout that waited too long: someone couldn't pay for a pack.
    expect(await handleJob(job, dependencies)).toEqual({ status: "skipped", entityId: checkoutId });
    expect(error.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/\] exception: Billing work waited longer than it should\.$/), operation: "job.billing.createPackCheckout", businessId: job.businessId, checkoutId, alertable: true }));
    // A checkout the business deleted under the job.
    expect(await handleJob(job, dependencies)).toEqual({ status: "skipped", entityId: checkoutId });
    // A job without a checkout does nothing.
    expect(await handleJob({ ...job, payload: {} }, dependencies)).toEqual({ status: "skipped", entityId: "" });
    expect(claimPackCheckout).toHaveBeenCalledTimes(4);
    expect(createCheckout).not.toHaveBeenCalled();
    expect(markPackCheckoutFailed).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("hands a checkout back while the provider fails and the job will try again, and fails it on the last try", async () => {
    const checkoutId = randomUUID();
    const job = packJob(checkoutId);
    const businessId = job.businessId!;
    const failure = new PolarRequestError(503, null);
    const polar: Partial<PolarBillingClient> = { findCustomerByExternalId: vi.fn().mockResolvedValue({ id: "customer-1", externalId: `business:${businessId}` }), createCheckout: vi.fn().mockRejectedValue(failure) };
    vi.mocked(claimPackCheckout).mockResolvedValue({ claimed: true });
    vi.mocked(loadPackCheckoutRequest).mockResolvedValue(work(job, { priceRef: "product-pack-500-90", customerId: "customer-1" }));

    await expect(handleJob(job, { domain, billing: polarFake(polar) }, { isFinalAttempt: false })).rejects.toBe(failure);
    expect(releasePackCheckout).toHaveBeenCalledWith(domain, { businessId, checkoutId });
    expect(markPackCheckoutFailed).not.toHaveBeenCalled();

    await expect(handleJob(job, { domain, billing: polarFake(polar) }, { isFinalAttempt: true })).rejects.toBe(failure);
    expect(markPackCheckoutFailed).toHaveBeenCalledWith(domain, { businessId, checkoutId, error: "Polar checkout creation failed." });
    expect(releasePackCheckout).toHaveBeenCalledTimes(1);
    expect(markPackCheckoutReady).not.toHaveBeenCalled();
  });

  it("fails a checkout whose email the provider has for another customer, or doesn't take, so the person gives another", async () => {
    vi.mocked(claimPackCheckout).mockResolvedValue({ claimed: true });
    for (const [kind, refusal] of [["PolarRequestValidationError", "billing_email_taken"], ["RequestValidationError", "billing_email_invalid"]] as const) {
      const job = packJob(randomUUID());
      const createCheckout = vi.fn();
      vi.mocked(loadPackCheckoutRequest).mockResolvedValue(work(job, { priceRef: "product-pack-500-90" }));
      const polar = { findCustomerByExternalId: vi.fn().mockResolvedValue(null), createCustomer: vi.fn().mockRejectedValue(new PolarRequestError(422, kind, ["email"])), createCheckout };

      expect(await handleJob(job, { domain, billing: polarFake(polar) }, { isFinalAttempt: false })).toEqual({ status: "skipped", entityId: job.payload.checkoutId });
      expect(markPackCheckoutFailed).toHaveBeenLastCalledWith(domain, { businessId: job.businessId, checkoutId: job.payload.checkoutId, error: planChangeRefusals[refusal] });
      expect(createCheckout).not.toHaveBeenCalled();
    }
    expect(releasePackCheckout).not.toHaveBeenCalled();
  });
});
