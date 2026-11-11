import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@lobbystack/contracts";
import { PolarRequestError, type PolarSubscription } from "@lobbystack/providers/polar/polarBilling";
import { claimBillingSubscription, polarProductLinks, readPolarProductLinks } from "@lobbystack/domain";
import { releaseBillingSubscription } from "@lobbystack/domain";
import { loadPromoEndWork, recordPromoEnd, type PromoEndWork } from "@lobbystack/domain";
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

describe("billing jobs: promo plans", () => {
  describe("a promo plan's end", () => {
    const productEnv = { POLAR_STARTER_MONTHLY_PRODUCT_ID: "product-starter-monthly", POLAR_PRO_MONTHLY_PRODUCT_ID: "product-pro-monthly" };
    const promoPrice = { plan: "salons-half-off", tier: "starter", status: "active", period: "monthly" as const, currency: "cad", cents: 3000, per_month: 3000, provider_ref: "promo-starter-monthly", retired: false };
    const otherPromoPrice = { ...promoPrice, plan: "pro-launch", tier: "pro", provider_ref: "promo-pro-monthly" };
    const planEnds = new Date(Date.now() + 5 * 86_400_000);
    const periodEnd = new Date(Date.now() + 6 * 86_400_000).toISOString();
    const subscription = (extra: Partial<PolarSubscription> = {}): PolarSubscription => ({ id: "sub-1", status: "active", productId: "promo-starter-monthly", cancelAtPeriodEnd: false, endedAt: null, pendingProductId: null, discountId: "disc-half-off", currentPeriodEnd: periodEnd, ...extra });
    const work = (extra: Partial<PromoEndWork> = {}): PromoEndWork => ({ planCode: "salons-half-off", planEnds, tier: "starter", interval: "monthly", subscriptionId: "sub-1", ending: "tier", endsAt: planEnds, set: true, notify: true, overdue: false, ...extra });

    function endPromo(input: { work: PromoEndWork | null; polar: Partial<PolarBillingClient>; payload?: Record<string, unknown> }) {
      const businessId = randomUUID();
      const domain = { db: undefined as never };
      for (const [key, value] of Object.entries(productEnv)) vi.stubEnv(key, value);
      vi.stubEnv("APP_BASE_URL", "https://app.example");
      vi.mocked(readPolarProductLinks).mockImplementation(async () => polarProductLinks({ plans: [], prices: [promoPrice, otherPromoPrice], others: [{ code: "salons-half-off", tier: "starter", status: "active", provider_disc: "disc-half-off" }, { code: "pro-launch", tier: "pro", status: "active", provider_disc: "disc-launch" }] } as never, process.env));
      vi.mocked(loadPromoEndWork).mockResolvedValue(input.work);
      vi.mocked(recordPromoEnd).mockResolvedValue(1);
      const job: JobEnvelope = { jobId: randomUUID(), type: "billing.endPromoPlan", queue: "default", businessId, payload: input.payload ?? {}, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: true };
      const run = handleJob(job, { domain, billing: polarFake({ recordUsage: vi.fn(), getSubscription: vi.fn(), changeSubscriptionProduct: vi.fn(), cancelSubscriptionAtPeriodEnd: vi.fn(), removeSubscriptionDiscount: vi.fn(), ...input.polar }) });
      return { businessId, domain, run };
    }

    afterEach(() => {
      vi.mocked(readPolarProductLinks).mockImplementation(async () => polarProductLinks({ plans: [], prices: [] }, process.env));
    });

    it("moves the subscription to its tier's standard product from the next period, without the discount, then emails the owners", async () => {
      const changeSubscriptionProduct = vi.fn().mockResolvedValue(subscription());
      const { businessId, domain, run } = endPromo({ work: work(), polar: { getSubscription: vi.fn().mockResolvedValue(subscription()), changeSubscriptionProduct } });
      await expect(run).resolves.toEqual({ status: "completed", entityId: `${businessId}:salons-half-off:1` });
      expect(changeSubscriptionProduct).toHaveBeenCalledWith({ subscriptionId: "sub-1", productId: "product-starter-monthly", prorationBehavior: "next_period", discountId: null });
      // The email names Polar's renewal date.
      expect(recordPromoEnd).toHaveBeenCalledWith(domain, { businessId, planCode: "salons-half-off", planEnds, set: true, notice: { ending: "tier", endsAt: new Date(periodEnd), tier: "starter", interval: "monthly", quiet: false }, appUrl: "https://app.example" });
    });

    it("cancels at the period's end for a plan that ends that way, and leaves a cancellation or a plan change the business chose", async () => {
      const cancelSubscriptionAtPeriodEnd = vi.fn().mockResolvedValue(subscription({ cancelAtPeriodEnd: true }));
      const cancel = endPromo({ work: work({ ending: "cancel" }), polar: { getSubscription: vi.fn().mockResolvedValue(subscription()), cancelSubscriptionAtPeriodEnd } });
      await expect(cancel.run).resolves.toMatchObject({ status: "completed" });
      expect(cancelSubscriptionAtPeriodEnd).toHaveBeenCalledWith("sub-1");

      const changeSubscriptionProduct = vi.fn();
      const canceling = endPromo({ work: work(), polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ cancelAtPeriodEnd: true })), changeSubscriptionProduct } });
      await expect(canceling.run).resolves.toMatchObject({ status: "completed" });
      expect(recordPromoEnd).toHaveBeenLastCalledWith(canceling.domain, expect.objectContaining({ notice: expect.objectContaining({ ending: "cancel" }) }));

      const chosen = endPromo({ work: work(), polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ pendingProductId: "product-pro-monthly" })), changeSubscriptionProduct } });
      await expect(chosen.run).resolves.toMatchObject({ status: "completed" });
      expect(recordPromoEnd).toHaveBeenLastCalledWith(chosen.domain, expect.objectContaining({ notice: { ending: "tier", endsAt: new Date(periodEnd), tier: "pro", interval: "monthly", quiet: false } }));
      // Another promo plan the business chose for the renewal stands too, and its owners saw its terms when they chose it.
      const promo = endPromo({ work: work(), polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ pendingProductId: "promo-pro-monthly" })), changeSubscriptionProduct } });
      await expect(promo.run).resolves.toMatchObject({ status: "completed" });
      expect(recordPromoEnd).toHaveBeenLastCalledWith(promo.domain, expect.objectContaining({ set: true, notice: { ending: "tier", endsAt: new Date(periodEnd), tier: "pro", interval: "monthly", quiet: true } }));
      expect(changeSubscriptionProduct).not.toHaveBeenCalled();
    });

    it("emails only once Polar is told, and leaves a refusal or an ended subscription for the next day's check", async () => {
      const refused = endPromo({ work: work(), polar: { getSubscription: vi.fn().mockResolvedValue(subscription()), changeSubscriptionProduct: vi.fn().mockRejectedValue(new PolarRequestError(403, "insufficient_scope")) } });
      await expect(refused.run).resolves.toEqual({ status: "skipped", entityId: refused.businessId });
      const ended = endPromo({ work: work(), polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ status: "canceled", endedAt: "2026-10-01T00:00:00Z" })) } });
      await expect(ended.run).resolves.toEqual({ status: "skipped", entityId: ended.businessId });
      expect(recordPromoEnd).not.toHaveBeenCalled();
      // Polar fails some other way: the job's retries take it.
      await expect(endPromo({ work: work(), polar: { getSubscription: vi.fn().mockRejectedValue(new PolarRequestError(500, null)) } }).run).rejects.toThrow("status 500");

      const getSubscription = vi.fn();
      const told = endPromo({ work: work({ set: false }), polar: { getSubscription } });
      await expect(told.run).resolves.toMatchObject({ status: "completed" });
      expect(getSubscription).not.toHaveBeenCalled();
      expect(recordPromoEnd).toHaveBeenCalledWith(told.domain, expect.objectContaining({ set: false, notice: { ending: "tier", endsAt: planEnds, tier: "starter", interval: "monthly", quiet: false } }));
      vi.mocked(recordPromoEnd).mockClear();
      // The rest of the last week: Polar was told and the owners heard.
      const done = endPromo({ work: work({ set: false, notify: false }), polar: { getSubscription } });
      await expect(done.run).resolves.toEqual({ status: "completed", entityId: `${done.businessId}:salons-half-off:0` });
      expect(recordPromoEnd).not.toHaveBeenCalled();
      expect(getSubscription).not.toHaveBeenCalled();
      await expect(endPromo({ work: null, polar: {} }).run).resolves.toMatchObject({ status: "skipped" });
    });

    it("leaves a subscription that left the promo plan, as after an upgrade the account hasn't heard of yet", async () => {
      const changeSubscriptionProduct = vi.fn();
      const cancelSubscriptionAtPeriodEnd = vi.fn();
      const upgraded = endPromo({ work: work(), polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ productId: "product-pro-monthly", discountId: null })), changeSubscriptionProduct, cancelSubscriptionAtPeriodEnd } });
      await expect(upgraded.run).resolves.toEqual({ status: "skipped", entityId: upgraded.businessId });
      // Another promo plan's product, and one the catalog doesn't know.
      for (const productId of ["promo-pro-monthly", "made-in-polar"]) {
        await expect(endPromo({ work: work({ ending: "cancel" }), polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ productId })), changeSubscriptionProduct, cancelSubscriptionAtPeriodEnd } }).run).resolves.toMatchObject({ status: "skipped" });
      }
      expect(changeSubscriptionProduct).not.toHaveBeenCalled();
      expect(cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
      expect(recordPromoEnd).not.toHaveBeenCalled();
    });

    it("waits while another change holds the subscription, and hands it back after", async () => {
      const retryAt = new Date(Date.now() + 15_000);
      const getSubscription = vi.fn().mockResolvedValue(subscription());
      vi.mocked(claimBillingSubscription).mockResolvedValueOnce({ retryAt });
      const held = endPromo({ work: work(), polar: { getSubscription } });
      await expect(held.run).resolves.toEqual({ status: "deferred", entityId: held.businessId, retryAt });
      vi.mocked(claimBillingSubscription).mockResolvedValueOnce({ retryAt });
      const heldDrop = endPromo({ work: null, payload: { dropDiscount: "disc-half-off", subscriptionId: "sub-1" }, polar: { getSubscription } });
      await expect(heldDrop.run).resolves.toEqual({ status: "deferred", entityId: heldDrop.businessId, retryAt });
      expect(getSubscription).not.toHaveBeenCalled();
      expect(recordPromoEnd).not.toHaveBeenCalled();

      const ending = endPromo({ work: work(), polar: { getSubscription, changeSubscriptionProduct: vi.fn().mockResolvedValue(subscription()) } });
      await expect(ending.run).resolves.toMatchObject({ status: "completed" });
      expect(releaseBillingSubscription).toHaveBeenLastCalledWith(ending.domain, { businessId: ending.businessId, claimId: "subscription-claim" });
      const failing = endPromo({ work: null, payload: { dropDiscount: "disc-half-off", subscriptionId: "sub-1" }, polar: { getSubscription: vi.fn().mockRejectedValue(new PolarRequestError(500, null)) } });
      await expect(failing.run).rejects.toThrow("status 500");
      expect(releaseBillingSubscription).toHaveBeenLastCalledWith(failing.domain, { businessId: failing.businessId, claimId: "subscription-claim" });

      // An email with nothing to tell Polar claims nothing.
      vi.mocked(claimBillingSubscription).mockClear();
      await expect(endPromo({ work: work({ set: false }), polar: { getSubscription } }).run).resolves.toMatchObject({ status: "completed" });
      expect(claimBillingSubscription).not.toHaveBeenCalled();
    });

    it("removes a promo plan's discount from a standard product, and nowhere else", async () => {
      const removeSubscriptionDiscount = vi.fn().mockResolvedValue(subscription({ productId: "product-starter-monthly" }));
      const payload = { dropDiscount: "disc-half-off", subscriptionId: "sub-1" };
      const standard = endPromo({ work: null, payload, polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ productId: "product-starter-monthly" })), removeSubscriptionDiscount } });
      await expect(standard.run).resolves.toEqual({ status: "completed", entityId: `${standard.businessId}:disc-half-off` });
      expect(removeSubscriptionDiscount).toHaveBeenCalledWith("sub-1");
      removeSubscriptionDiscount.mockClear();
      await expect(endPromo({ work: null, payload, polar: { getSubscription: vi.fn().mockResolvedValue(subscription()), removeSubscriptionDiscount } }).run).resolves.toMatchObject({ status: "skipped" });
      await expect(endPromo({ work: null, payload, polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ productId: "product-starter-monthly", discountId: null })), removeSubscriptionDiscount } }).run).resolves.toMatchObject({ status: "skipped" });
      // A standard product waiting to move to a promo plan keeps the discount that plan's change brought.
      await expect(endPromo({ work: null, payload, polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ productId: "product-starter-monthly", pendingProductId: "promo-starter-monthly" })), removeSubscriptionDiscount } }).run).resolves.toMatchObject({ status: "skipped" });
      expect(removeSubscriptionDiscount).not.toHaveBeenCalled();
      expect(loadPromoEndWork).not.toHaveBeenCalled();
    });

    it("tries a discount removal again while Polar holds an earlier change, as nothing queues it again", async () => {
      const payload = { dropDiscount: "disc-half-off", subscriptionId: "sub-1" };
      const getSubscription = vi.fn().mockResolvedValue(subscription({ productId: "product-starter-monthly" }));
      await expect(endPromo({ work: null, payload, polar: { getSubscription, removeSubscriptionDiscount: vi.fn().mockRejectedValue(new PolarRequestError(409, null)) } }).run).rejects.toThrow("status 409");
      await expect(endPromo({ work: null, payload, polar: { getSubscription, removeSubscriptionDiscount: vi.fn().mockRejectedValue(new PolarRequestError(403, "insufficient_scope")) } }).run).resolves.toMatchObject({ status: "skipped" });
    });
  });
});
