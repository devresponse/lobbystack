import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@lobbystack/contracts";
import { PolarRequestError, type PolarSubscription } from "@lobbystack/providers/polar/polarBilling";
import { planChangeRefusals } from "@lobbystack/shared";
import { claimBillingCheckoutRequest, claimBillingSubscription, loadBillingCheckoutRequest, loadPlanChangeProration, polarProductLinks, readPolarProductLinks, markBillingCheckoutCreated, markBillingCheckoutFailed, markBillingPlanChanged } from "@lobbystack/domain";
import { releaseBillingCheckoutRequest, releaseBillingSubscription } from "@lobbystack/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lobbystack/shared", async (importOriginal) => (await import("./testing")).mockShared(importOriginal));
vi.mock("@lobbystack/domain", async (importOriginal) => (await import("./testing")).mockDomain(importOriginal));

import { handleJob, type WorkerDependencies } from "../handlers";
import { brand } from "./testing";
import { polarFake } from "./polarFake";
import type { PolarBillingClient } from "@lobbystack/providers/polar/adapter";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  brand.appBaseUrl = null;
});

describe("billing jobs: plan changes", () => {
  describe("a business that already pays", () => {
    const productEnv = { POLAR_STARTER_MONTHLY_PRODUCT_ID: "product-starter-monthly", POLAR_STARTER_ANNUAL_PRODUCT_ID: "product-starter-annual", POLAR_PRO_MONTHLY_PRODUCT_ID: "product-pro-monthly", POLAR_PRO_ANNUAL_PRODUCT_ID: "product-pro-annual" };
    const liveSubscription = (productId: string, extra: Partial<PolarSubscription> = {}): PolarSubscription => ({ id: "sub-1", status: "active", productId, cancelAtPeriodEnd: false, endedAt: null, pendingProductId: null, discountId: null, currentPeriodEnd: null, ...extra });

    function changePlan(input: { target: "starter" | "pro"; billingInterval: "monthly" | "annual"; plan: "starter" | "pro"; planCode?: string; subscriptionPlanCode?: string; polar: Partial<PolarBillingClient>; isFinalAttempt?: boolean }) {
      const businessId = randomUUID();
      const requestId = randomUUID();
      const domain = { db: undefined as never };
      for (const [key, value] of Object.entries(productEnv)) vi.stubEnv(key, value);
      vi.mocked(claimBillingCheckoutRequest).mockResolvedValue({ claimed: true });
      vi.mocked(markBillingCheckoutFailed).mockResolvedValue(true);
      vi.mocked(markBillingPlanChanged).mockResolvedValue(true);
      vi.mocked(loadPlanChangeProration).mockResolvedValue({ upgrade: "invoice", downgrade: "next_period" });
      vi.mocked(loadBillingCheckoutRequest).mockResolvedValue({ id: requestId, businessId, target: input.target, billingInterval: input.billingInterval, status: "processing", checkoutId: null, checkoutUrl: null, error: null, customerEmail: "owner@example.com", customerId: null, externalCustomerId: `business:${businessId}`, billingEmail: null, businessName: "Allo Salon", onboardingStage: "complete", planCode: input.planCode ?? null, subscription: { id: "sub-1", plan: input.plan, billingInterval: "monthly", planCode: input.subscriptionPlanCode ?? null } });
      const job: JobEnvelope = { jobId: randomUUID(), type: "billing.createCheckout", queue: "critical", businessId, payload: { requestId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
      const run = handleJob(job, { domain, billing: polarFake({ recordUsage: vi.fn(), createCheckout: vi.fn(), ...input.polar }) }, input.isFinalAttempt === undefined ? {} : { isFinalAttempt: input.isFinalAttempt });
      return { businessId, requestId, domain, run };
    }

    it("moves Starter to Pro on the same subscription, invoiced now, instead of a second checkout", async () => {
      const createCheckout = vi.fn();
      const getSubscription = vi.fn().mockResolvedValue(liveSubscription("product-starter-monthly"));
      const changeSubscriptionProduct = vi.fn().mockResolvedValue(liveSubscription("product-pro-annual"));
      const { businessId, requestId, domain, run } = await changePlan({ target: "pro", billingInterval: "annual", plan: "starter", polar: { createCheckout, getSubscription, changeSubscriptionProduct } });

      await expect(run).resolves.toEqual({ status: "completed", entityId: requestId });
      expect(getSubscription).toHaveBeenCalledWith("sub-1");
      expect(changeSubscriptionProduct).toHaveBeenCalledWith({ subscriptionId: "sub-1", productId: "product-pro-annual", prorationBehavior: "invoice" });
      expect(markBillingPlanChanged).toHaveBeenCalledWith(domain, { businessId, requestId });
      expect(createCheckout).not.toHaveBeenCalled();
    });

    it("moves Pro to Starter from the next period, going by Polar's product rather than the stored plan", async () => {
      const changeSubscriptionProduct = vi.fn().mockResolvedValue(liveSubscription("product-pro-monthly", { pendingProductId: "product-starter-monthly" }));
      const { run } = await changePlan({ target: "starter", billingInterval: "monthly", plan: "starter", polar: { getSubscription: vi.fn().mockResolvedValue(liveSubscription("product-pro-monthly")), changeSubscriptionProduct } });

      await expect(run).resolves.toMatchObject({ status: "completed" });
      expect(changeSubscriptionProduct).toHaveBeenCalledWith(expect.objectContaining({ productId: "product-starter-monthly", prorationBehavior: "next_period" }));
    });

    it("marks a change Polar already made without making it twice", async () => {
      const changeSubscriptionProduct = vi.fn();
      const { run } = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { getSubscription: vi.fn().mockResolvedValue(liveSubscription("product-pro-monthly")), changeSubscriptionProduct } });

      await expect(run).resolves.toMatchObject({ status: "completed" });
      expect(changeSubscriptionProduct).not.toHaveBeenCalled();
      expect(markBillingPlanChanged).toHaveBeenCalled();
    });

    it("tells the business why when Polar can't charge the change, without retrying", async () => {
      const changeSubscriptionProduct = vi.fn().mockRejectedValue(new PolarRequestError(402, "PaymentFailed"));
      const { businessId, requestId, domain, run } = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { getSubscription: vi.fn().mockResolvedValue(liveSubscription("product-starter-monthly")), changeSubscriptionProduct } });

      await expect(run).resolves.toEqual({ status: "skipped", entityId: requestId });
      expect(markBillingCheckoutFailed).toHaveBeenCalledWith(domain, { businessId, requestId, error: planChangeRefusals.payment_failed });
      expect(markBillingPlanChanged).not.toHaveBeenCalled();
    });

    it("refuses a subscription set to end, and names a token without write access as the operator's to fix", async () => {
      const ending = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { getSubscription: vi.fn().mockResolvedValue(liveSubscription("product-starter-monthly", { cancelAtPeriodEnd: true })), changeSubscriptionProduct: vi.fn() } });
      await expect(ending.run).resolves.toMatchObject({ status: "skipped" });
      expect(markBillingCheckoutFailed).toHaveBeenCalledWith(ending.domain, { businessId: ending.businessId, requestId: ending.requestId, error: planChangeRefusals.subscription_ending });

      const scope = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { getSubscription: vi.fn().mockRejectedValue(new PolarRequestError(403, "insufficient_scope")), changeSubscriptionProduct: vi.fn() } });
      await expect(scope.run).resolves.toMatchObject({ status: "skipped" });
      expect(markBillingCheckoutFailed).toHaveBeenCalledWith(scope.domain, { businessId: scope.businessId, requestId: scope.requestId, error: planChangeRefusals.token_scope });
    });

    it("retries when Polar fails for another reason, and the page keeps waiting until the last try fails", async () => {
      const error = new PolarRequestError(503, null);
      const polar = () => ({ getSubscription: vi.fn().mockResolvedValue(liveSubscription("product-starter-monthly")), changeSubscriptionProduct: vi.fn().mockRejectedValue(error) });
      const retrying = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: polar(), isFinalAttempt: false });

      await expect(retrying.run).rejects.toBe(error);
      expect(releaseBillingCheckoutRequest).toHaveBeenCalledWith(retrying.domain, { businessId: retrying.businessId, requestId: retrying.requestId });
      expect(markBillingCheckoutFailed).not.toHaveBeenCalled();

      const last = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: polar(), isFinalAttempt: true });
      await expect(last.run).rejects.toBe(error);
      expect(markBillingCheckoutFailed).toHaveBeenCalledWith(last.domain, { businessId: last.businessId, requestId: last.requestId, error: "Polar plan change failed." });
      expect(releaseBillingCheckoutRequest).toHaveBeenCalledTimes(1);
    });

    it("waits while another change holds the subscription, handing the request back, and hands the subscription back after", async () => {
      const retryAt = new Date(Date.now() + 15_000);
      vi.mocked(claimBillingSubscription).mockResolvedValueOnce({ retryAt });
      const getSubscription = vi.fn().mockResolvedValue(liveSubscription("product-starter-monthly"));
      const changeSubscriptionProduct = vi.fn().mockResolvedValue(liveSubscription("product-pro-monthly"));
      const held = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { getSubscription, changeSubscriptionProduct } });
      await expect(held.run).resolves.toEqual({ status: "deferred", entityId: held.requestId, retryAt });
      expect(getSubscription).not.toHaveBeenCalled();
      expect(releaseBillingCheckoutRequest).toHaveBeenCalledWith(held.domain, { businessId: held.businessId, requestId: held.requestId });
      expect(releaseBillingSubscription).not.toHaveBeenCalled();

      const free = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { getSubscription, changeSubscriptionProduct } });
      await expect(free.run).resolves.toMatchObject({ status: "completed" });
      expect(claimBillingSubscription).toHaveBeenLastCalledWith(free.domain, { businessId: free.businessId });
      expect(releaseBillingSubscription).toHaveBeenCalledWith(free.domain, { businessId: free.businessId, claimId: "subscription-claim" });

      // A failed try hands it back too, and a failed hand-back leaves the claim to run out.
      vi.mocked(releaseBillingSubscription).mockRejectedValueOnce(new Error("connection terminated"));
      const error = new PolarRequestError(503, null);
      const failing = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { getSubscription, changeSubscriptionProduct: vi.fn().mockRejectedValue(error) }, isFinalAttempt: false });
      await expect(failing.run).rejects.toBe(error);
      expect(releaseBillingSubscription).toHaveBeenLastCalledWith(failing.domain, { businessId: failing.businessId, claimId: "subscription-claim" });
    });

    it("opens a checkout when Polar's subscription has already ended", async () => {
      vi.mocked(markBillingCheckoutCreated).mockResolvedValue(true as never);
      const createCheckout = vi.fn().mockResolvedValue({ checkoutId: "checkout-1", checkoutUrl: "https://polar.example/checkout-1" });
      const changeSubscriptionProduct = vi.fn();
      const { run } = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { createCheckout, getSubscription: vi.fn().mockResolvedValue(liveSubscription("product-starter-monthly", { status: "canceled", endedAt: "2026-10-01T00:00:00Z" })), changeSubscriptionProduct } });

      await expect(run).resolves.toMatchObject({ status: "completed" });
      expect(changeSubscriptionProduct).not.toHaveBeenCalled();
      expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ productId: "product-pro-monthly" }));
    });

    it("sells through the catalog's linked products once a link made the plan active, and reads Polar's product through them", async () => {
      const linked = (code: "starter" | "pro") => ({ code, status: "active" as const, sold: true, custom: false, overage: true, voice_sec: null, sms_seg: null, calls_out: null, chat_units: null, kb_bytes: null, numbers: null, receptionists: null, voice_rate: null, sms_rate: null, call_rate: null, sort: 0 });
      const price = (plan: "starter" | "pro", period: "monthly" | "annual", polarId: string, retired = false) => ({ plan, tier: plan, status: "active", period, currency: "cad", cents: 1, per_month: 1, provider_ref: polarId, retired });
      const catalog = { plans: [linked("starter"), linked("pro")], prices: [price("starter", "monthly", "catalog-starter-monthly"), price("starter", "annual", "catalog-starter-annual"), price("pro", "annual", "catalog-pro-annual"), price("pro", "annual", "old-pro-annual", true)] };
      const links = async () => polarProductLinks(catalog, process.env);
      vi.mocked(readPolarProductLinks).mockImplementationOnce(links).mockImplementationOnce(links);
      const changeSubscriptionProduct = vi.fn().mockResolvedValue(liveSubscription("old-pro-annual", { pendingProductId: "catalog-starter-annual" }));
      // Polar's product is a retired Pro annual price, so the move to Starter annual waits for the
      // next period, though the account still says Starter monthly.
      const { run } = await changePlan({ target: "starter", billingInterval: "annual", plan: "starter", polar: { getSubscription: vi.fn().mockResolvedValue(liveSubscription("old-pro-annual")), changeSubscriptionProduct } });

      await expect(run).resolves.toMatchObject({ status: "completed" });
      expect(changeSubscriptionProduct).toHaveBeenCalledWith({ subscriptionId: "sub-1", productId: "catalog-starter-annual", prorationBehavior: "next_period" });

      // Pro monthly has no linked product, so its variable no longer sells it.
      const unlinked = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { getSubscription: vi.fn().mockResolvedValue(liveSubscription("catalog-starter-monthly")), changeSubscriptionProduct: vi.fn() } });
      await expect(unlinked.run).rejects.toThrow("No Polar product sells pro monthly");
      expect(markBillingCheckoutFailed).toHaveBeenCalledWith(unlinked.domain, { businessId: unlinked.businessId, requestId: unlinked.requestId, error: "Polar plan change failed." });
    });
  });
});
