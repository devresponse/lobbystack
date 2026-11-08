import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@lobbystack/contracts";
import { PolarRequestError, type PolarSubscription } from "@lobbystack/providers/polar/polarBilling";
import { planChangeRefusalOf, planChangeRefusals } from "@lobbystack/shared";
import { claimBillingCheckoutRequest, loadBillingCheckoutRequest, loadPlanChangeProration, polarProductLinks, readPolarProductLinks, markBillingCheckoutCreated, markBillingCheckoutFailed, markBillingPlanChanged } from "@lobbystack/domain";
import { releaseBillingCheckoutRequest } from "@lobbystack/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lobbystack/shared", async (importOriginal) => (await import("./testing")).mockShared(importOriginal));
vi.mock("@lobbystack/domain", async (importOriginal) => (await import("./testing")).mockDomain(importOriginal));

import { handleJob, type WorkerDependencies } from "../handlers";
import { brand } from "./testing";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  brand.appBaseUrl = null;
});

describe("billing jobs: checkout", () => {
  it("fails checkout requests instead of leaving them pending when Polar is unavailable", async () => {
    const businessId = randomUUID();
    const requestId = randomUUID();
    const domain = { db: undefined as never };
    vi.mocked(claimBillingCheckoutRequest).mockResolvedValue({ claimed: true });
    vi.mocked(markBillingCheckoutFailed).mockResolvedValue(true);

    const result = await handleJob({
      jobId: randomUUID(),
      type: "billing.createCheckout",
      queue: "critical",
      businessId,
      payload: { requestId },
      trace: {},
      idempotencyKey: `test:${randomUUID()}`,
      scheduled: false,
    }, { domain });

    expect(result).toEqual({ status: "skipped", entityId: requestId });
    expect(markBillingCheckoutFailed).toHaveBeenCalledWith(domain, { businessId, requestId, error: "Billing checkout provider is not configured." });
    expect(loadBillingCheckoutRequest).not.toHaveBeenCalled();
    expect(markBillingCheckoutCreated).not.toHaveBeenCalled();
  });

  it("sends Polar's back arrow to the plan page without marking checkout successful", async () => {
    const businessId = randomUUID();
    const requestId = randomUUID();
    const domain = { db: undefined as never };
    vi.stubEnv("APP_BASE_URL", "https://app.example/");
    vi.stubEnv("POLAR_STARTER_MONTHLY_PRODUCT_ID", "product-starter-monthly");
    vi.mocked(claimBillingCheckoutRequest).mockResolvedValue({ claimed: true });
    vi.mocked(loadBillingCheckoutRequest).mockResolvedValue({ id: requestId, businessId, target: "starter", billingInterval: "monthly", status: "processing", checkoutId: null, checkoutUrl: null, error: null, customerEmail: "owner@example.com", externalCustomerId: `business:${businessId}`, billingEmail: null, businessName: "Allo Salon", onboardingStage: "complete", planCode: null, subscription: null });
    vi.mocked(markBillingCheckoutCreated).mockResolvedValue(true as never);
    const createCheckout = vi.fn().mockResolvedValue({ checkoutId: "checkout-1", checkoutUrl: "https://polar.example/checkout-1" });

    const result = await handleJob({
      jobId: randomUUID(),
      type: "billing.createCheckout",
      queue: "critical",
      businessId,
      payload: { requestId },
      trace: {},
      idempotencyKey: `test:${randomUUID()}`,
      scheduled: false,
    }, { domain, polar: { recordUsage: vi.fn(), createCheckout } });

    expect(result).toEqual({ status: "completed", entityId: requestId });
    expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({
      productId: "product-starter-monthly",
      customer: { email: "owner@example.com", externalId: `business:${businessId}` },
      metadata: { lobbystack_business: businessId },
      successUrl: `https://app.example/settings/plan?checkout=success&requestId=${requestId}`,
      returnUrl: "https://app.example/settings/plan",
    }));
    vi.unstubAllEnvs();
  });

  it("waits for a checkout another run holds until that run's claim goes stale, and skips one that is done", async () => {
    const businessId = randomUUID();
    const requestId = randomUUID();
    const retryAt = new Date("2026-10-24T12:05:00Z");
    const job: JobEnvelope = { jobId: randomUUID(), type: "billing.createCheckout", queue: "critical", businessId, payload: { requestId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
    const createCheckout = vi.fn();
    vi.mocked(claimBillingCheckoutRequest).mockResolvedValueOnce({ claimed: false, retryAt }).mockResolvedValueOnce({ claimed: false, retryAt: null });

    expect(await handleJob(job, { domain: { db: undefined as never }, polar: { recordUsage: vi.fn(), createCheckout } })).toEqual({ status: "deferred", entityId: requestId, retryAt });
    expect(await handleJob(job, { domain: { db: undefined as never }, polar: { recordUsage: vi.fn(), createCheckout } })).toEqual({ status: "skipped", entityId: requestId });
    expect(loadBillingCheckoutRequest).not.toHaveBeenCalled();
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("reports a checkout that waited too long for its job, which failed it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const businessId = randomUUID();
    const requestId = randomUUID();
    const job: JobEnvelope = { jobId: randomUUID(), type: "billing.createCheckout", queue: "critical", businessId, payload: { requestId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
    vi.mocked(claimBillingCheckoutRequest).mockResolvedValueOnce({ claimed: false, retryAt: null, expired: true });

    expect(await handleJob(job, { domain: { db: undefined as never }, polar: { recordUsage: vi.fn(), createCheckout: vi.fn() } })).toEqual({ status: "skipped", entityId: requestId });
    expect(error.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/\] exception: Billing work waited longer than it should\.$/), operation: "job.billing.createCheckout", businessId, requestId, alertable: true }));
    expect(loadBillingCheckoutRequest).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("hands a checkout back while Polar fails and the job will try again, and fails it on the last try", async () => {
    const businessId = randomUUID();
    const requestId = randomUUID();
    const domain = { db: undefined as never };
    vi.stubEnv("POLAR_STARTER_MONTHLY_PRODUCT_ID", "product-starter-monthly");
    vi.mocked(claimBillingCheckoutRequest).mockResolvedValue({ claimed: true });
    vi.mocked(loadBillingCheckoutRequest).mockResolvedValue({ id: requestId, businessId, target: "starter", billingInterval: "monthly", status: "processing", checkoutId: null, checkoutUrl: null, error: null, customerEmail: "owner@example.com", externalCustomerId: `business:${businessId}`, billingEmail: null, businessName: "Allo Salon", onboardingStage: "complete", planCode: null, subscription: null });
    const error = new PolarRequestError(503, null);
    const createCheckout = vi.fn().mockRejectedValue(error);
    const job: JobEnvelope = { jobId: randomUUID(), type: "billing.createCheckout", queue: "critical", businessId, payload: { requestId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };

    await expect(handleJob(job, { domain, polar: { recordUsage: vi.fn(), createCheckout } }, { isFinalAttempt: false })).rejects.toBe(error);
    expect(releaseBillingCheckoutRequest).toHaveBeenCalledWith(domain, { businessId, requestId });
    expect(markBillingCheckoutFailed).not.toHaveBeenCalled();

    await expect(handleJob(job, { domain, polar: { recordUsage: vi.fn(), createCheckout } }, { isFinalAttempt: true })).rejects.toBe(error);
    expect(markBillingCheckoutFailed).toHaveBeenCalledWith(domain, { businessId, requestId, error: "Polar checkout creation failed." });
    expect(releaseBillingCheckoutRequest).toHaveBeenCalledTimes(1);
  });

  describe("a checkout's Polar customer", () => {
    function checkout(input: { billingEmail?: string; isFinalAttempt?: boolean; polar: Partial<NonNullable<WorkerDependencies["polar"]>> }) {
      const businessId = randomUUID();
      const requestId = randomUUID();
      const domain = { db: undefined as never };
      vi.stubEnv("POLAR_STARTER_MONTHLY_PRODUCT_ID", "product-starter-monthly");
      vi.mocked(claimBillingCheckoutRequest).mockResolvedValue({ claimed: true });
      vi.mocked(markBillingCheckoutFailed).mockResolvedValue(true);
      vi.mocked(markBillingCheckoutCreated).mockResolvedValue(true as never);
      vi.mocked(loadBillingCheckoutRequest).mockResolvedValue({ id: requestId, businessId, target: "starter", billingInterval: "monthly", status: "processing", checkoutId: null, checkoutUrl: null, error: null, customerEmail: "owner@example.com", externalCustomerId: `business:${businessId}`, billingEmail: input.billingEmail ?? null, businessName: "Allo Salon", onboardingStage: "complete", planCode: null, subscription: null });
      const createCheckout = vi.fn().mockResolvedValue({ checkoutId: "checkout-1", checkoutUrl: "https://polar.example/checkout-1" });
      const job: JobEnvelope = { jobId: randomUUID(), type: "billing.createCheckout", queue: "critical", businessId, payload: { requestId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
      const run = handleJob(job, { domain, polar: { recordUsage: vi.fn(), createCheckout, findCustomerByExternalId: vi.fn().mockResolvedValue(null), createCustomer: vi.fn(), ...input.polar } }, { isFinalAttempt: input.isFinalAttempt ?? true });
      return { businessId, requestId, domain, createCheckout, run };
    }

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("makes the checkout out to the business's own customer, found by its billing key", async () => {
      const findCustomerByExternalId = vi.fn().mockResolvedValue({ id: "customer-1", externalId: "business:1" });
      const createCustomer = vi.fn();
      const { businessId, requestId, createCheckout, run } = checkout({ polar: { findCustomerByExternalId, createCustomer } });

      await expect(run).resolves.toEqual({ status: "completed", entityId: requestId });
      expect(findCustomerByExternalId).toHaveBeenCalledWith(`business:${businessId}`);
      expect(createCustomer).not.toHaveBeenCalled();
      expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ customer: { id: "customer-1" }, metadata: { lobbystack_business: businessId } }));
    });

    it("makes the business its customer with the billing email it was given, else the person's own", async () => {
      const createCustomer = vi.fn().mockResolvedValue({ id: "customer-2", externalId: null });
      const given = checkout({ billingEmail: "billing@example.com", polar: { createCustomer } });
      await expect(given.run).resolves.toEqual({ status: "completed", entityId: given.requestId });
      expect(createCustomer).toHaveBeenCalledWith({ externalId: `business:${given.businessId}`, email: "billing@example.com", name: "Allo Salon" });
      expect(given.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ customer: { id: "customer-2" } }));

      const own = checkout({ polar: { createCustomer } });
      await expect(own.run).resolves.toEqual({ status: "completed", entityId: own.requestId });
      expect(createCustomer).toHaveBeenLastCalledWith({ externalId: `business:${own.businessId}`, email: "owner@example.com", name: "Allo Salon" });
    });

    it("uses the customer another run made first", async () => {
      const findCustomerByExternalId = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "customer-3", externalId: "business:1" });
      const createCustomer = vi.fn().mockRejectedValue(new PolarRequestError(422, "PolarRequestValidationError", ["email", "external_id"]));
      const { requestId, createCheckout, run } = checkout({ polar: { findCustomerByExternalId, createCustomer } });

      await expect(run).resolves.toEqual({ status: "completed", entityId: requestId });
      expect(findCustomerByExternalId).toHaveBeenCalledTimes(2);
      expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ customer: { id: "customer-3" } }));
    });

    it("fails a checkout whose email Polar has for another business's customer, or doesn't take, so the person gives another", async () => {
      const taken = checkout({ polar: { createCustomer: vi.fn().mockRejectedValue(new PolarRequestError(422, "PolarRequestValidationError", ["email"])) } });
      await expect(taken.run).resolves.toEqual({ status: "skipped", entityId: taken.requestId });
      expect(markBillingCheckoutFailed).toHaveBeenCalledWith(taken.domain, { businessId: taken.businessId, requestId: taken.requestId, error: planChangeRefusals.billing_email_taken });
      expect(taken.createCheckout).not.toHaveBeenCalled();

      const invalid = checkout({ billingEmail: "billing@example.invalid", polar: { createCustomer: vi.fn().mockRejectedValue(new PolarRequestError(422, "RequestValidationError", ["email"])) } });
      await expect(invalid.run).resolves.toEqual({ status: "skipped", entityId: invalid.requestId });
      expect(markBillingCheckoutFailed).toHaveBeenLastCalledWith(invalid.domain, { businessId: invalid.businessId, requestId: invalid.requestId, error: planChangeRefusals.billing_email_invalid });
      expect(planChangeRefusalOf(planChangeRefusals.billing_email_taken)).toBe("billing_email_taken");
      expect(releaseBillingCheckoutRequest).not.toHaveBeenCalled();
    });

    it("leaves the customer to Polar's email match, and warns, when the worker's token can't read or make customers", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { businessId, requestId, createCheckout, run } = checkout({ polar: { findCustomerByExternalId: vi.fn().mockRejectedValue(new PolarRequestError(403, "insufficient_scope")) } });

      await expect(run).resolves.toEqual({ status: "completed", entityId: requestId });
      expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ customer: { email: "owner@example.com", externalId: `business:${businessId}` }, metadata: { lobbystack_business: businessId } }));
      const lines = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      expect(lines).toContainEqual(expect.objectContaining({ level: "warn", message: expect.stringMatching(/customers:write scope\.$/), operation: "job.billing.createCheckout", businessId, requestId }));
      warn.mockRestore();
    });

    it("tries again when Polar can't be reached, as any checkout does", async () => {
      const error = new PolarRequestError(503, null);
      const { businessId, requestId, domain, createCheckout, run } = checkout({ isFinalAttempt: false, polar: { findCustomerByExternalId: vi.fn().mockRejectedValue(error) } });

      await expect(run).rejects.toBe(error);
      expect(createCheckout).not.toHaveBeenCalled();
      expect(releaseBillingCheckoutRequest).toHaveBeenCalledWith(domain, { businessId, requestId });
      expect(markBillingCheckoutFailed).not.toHaveBeenCalled();
    });
  });

  describe("a promo plan", () => {
    const promoPrice = { plan: "salons-half-off", tier: "starter", status: "active", period: "monthly" as const, currency: "cad", cents: 3000, per_month: 3000, polar_id: "promo-starter-monthly", retired: false };
    const catalog = (status: "draft" | "active") => ({ plans: [], prices: [promoPrice], others: [{ code: "salons-half-off", tier: "starter", status, polar_disc: "disc-half-off" }] });
    const metadata = (businessId: string, requestId: string) => ({ lobbystack_business: businessId, lobbystack_plan: "salons-half-off", lobbystack_checkout: requestId });

    function promoCheckout(input: { status?: "draft" | "active"; subscription?: { plan: "starter" | "pro"; planCode: string | null } | null; planCode?: string | null; polar: Partial<NonNullable<WorkerDependencies["polar"]>> }) {
      const businessId = randomUUID();
      const requestId = randomUUID();
      const domain = { db: undefined as never };
      vi.stubEnv("APP_BASE_URL", "https://app.example");
      vi.mocked(claimBillingCheckoutRequest).mockResolvedValue({ claimed: true });
      vi.mocked(markBillingCheckoutFailed).mockResolvedValue(true);
      vi.mocked(markBillingCheckoutCreated).mockResolvedValue(true as never);
      vi.mocked(markBillingPlanChanged).mockResolvedValue(true);
      vi.mocked(loadPlanChangeProration).mockResolvedValue({ upgrade: "invoice", downgrade: "next_period" });
      const links = async () => polarProductLinks(catalog(input.status ?? "active"), process.env);
      vi.mocked(readPolarProductLinks).mockImplementation(links);
      const subscription = input.subscription ? { id: "sub-1", billingInterval: "monthly" as const, ...input.subscription } : null;
      vi.mocked(loadBillingCheckoutRequest).mockResolvedValue({ id: requestId, businessId, target: "starter", billingInterval: "monthly", status: "processing", checkoutId: null, checkoutUrl: null, error: null, customerEmail: "owner@example.com", externalCustomerId: `business:${businessId}`, billingEmail: null, businessName: "Allo Salon", onboardingStage: "complete", planCode: input.planCode === undefined ? "salons-half-off" : input.planCode, subscription });
      const job: JobEnvelope = { jobId: randomUUID(), type: "billing.createCheckout", queue: "critical", businessId, payload: { requestId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
      const run = handleJob(job, { domain, polar: { recordUsage: vi.fn(), createCheckout: vi.fn(), ...input.polar } });
      return { businessId, requestId, domain, run };
    }

    afterEach(() => {
      vi.mocked(readPolarProductLinks).mockImplementation(async () => polarProductLinks({ plans: [], prices: [] }, process.env));
      vi.unstubAllEnvs();
    });

    it("sells its own product with its discount and the checkout's metadata, and never lets a typed code stack on it", async () => {
      const createCheckout = vi.fn().mockResolvedValue({ checkoutId: "checkout-1", checkoutUrl: "https://polar.example/checkout-1" });
      const { businessId, requestId, run } = promoCheckout({ polar: { createCheckout } });
      await expect(run).resolves.toEqual({ status: "completed", entityId: requestId });
      expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ productId: "promo-starter-monthly", discountId: "disc-half-off", metadata: metadata(businessId, requestId) }));
    });

    it("fails the request when the plan isn't on sale, without asking Polar", async () => {
      const createCheckout = vi.fn();
      const { businessId, requestId, domain, run } = promoCheckout({ status: "draft", polar: { createCheckout } });
      await expect(run).resolves.toEqual({ status: "skipped", entityId: requestId });
      expect(markBillingCheckoutFailed).toHaveBeenCalledWith(domain, { businessId, requestId, error: "This promo plan isn't on sale right now." });
      expect(createCheckout).not.toHaveBeenCalled();
    });

    it("moves a paying business's subscription onto it with its discount, and drops the discount when it leaves for a standard plan", async () => {
      const liveSubscription = (productId: string): PolarSubscription => ({ id: "sub-1", status: "active", productId, cancelAtPeriodEnd: false, endedAt: null, pendingProductId: null, discountId: null, currentPeriodEnd: null });
      const changeSubscriptionProduct = vi.fn().mockResolvedValue(liveSubscription("promo-starter-monthly"));
      const onto = promoCheckout({ subscription: { plan: "pro", planCode: null }, polar: { getSubscription: vi.fn().mockResolvedValue(liveSubscription("product-pro-monthly")), changeSubscriptionProduct } });
      await expect(onto.run).resolves.toEqual({ status: "completed", entityId: onto.requestId });
      expect(changeSubscriptionProduct).toHaveBeenCalledWith({ subscriptionId: "sub-1", productId: "promo-starter-monthly", prorationBehavior: expect.any(String), discountId: "disc-half-off", metadata: metadata(onto.businessId, onto.requestId) });

      vi.stubEnv("POLAR_STARTER_MONTHLY_PRODUCT_ID", "product-starter-monthly");
      changeSubscriptionProduct.mockClear();
      const off = promoCheckout({ planCode: null, subscription: { plan: "starter", planCode: "salons-half-off" }, polar: { getSubscription: vi.fn().mockResolvedValue(liveSubscription("promo-starter-monthly")), changeSubscriptionProduct } });
      await expect(off.run).resolves.toEqual({ status: "completed", entityId: off.requestId });
      expect(changeSubscriptionProduct).toHaveBeenCalledWith({ subscriptionId: "sub-1", productId: "product-starter-monthly", prorationBehavior: expect.any(String), discountId: null });
    });
  });
});
