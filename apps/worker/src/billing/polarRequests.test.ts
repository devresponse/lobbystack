// Every request Polar receives in the worker's billing flows, made by the real
// Polar client against a stub of fetch and saved as a snapshot. Moving Polar
// behind the billing provider interface (the Stripe plan's first phase) must
// not change it; a later change to it says why in its commit.
import type { JobEnvelope } from "@lobbystack/contracts";
import { PolarBillingProvider } from "@lobbystack/providers/polar/polarBilling";
import { claimBillingCheckoutRequest, claimBillingUsageSync, confirmBillingUsageSync, loadBillingCheckoutRequest, loadBillingUsageEvent, loadPlanChangeProration, loadPromoEndWork, markBillingCheckoutCreated, markBillingPlanChanged, polarProductLinks, readPolarProductLinks, recordDeletedBusinessPlanEnded, recordPromoEnd, type PromoEndWork } from "@lobbystack/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lobbystack/shared", async (importOriginal) => (await import("./testing")).mockShared(importOriginal));
vi.mock("@lobbystack/domain", async (importOriginal) => (await import("./testing")).mockDomain(importOriginal));

import { handleJob, type WorkerDependencies } from "../handlers";
import { brand } from "./testing";
import { polarFake } from "./polarFake";

const businessId = "00000000-0000-4000-8000-0000000000b1";
const requestId = "00000000-0000-4000-8000-0000000000c1";
const productEnv = { POLAR_STARTER_MONTHLY_PRODUCT_ID: "product-starter-monthly", POLAR_STARTER_ANNUAL_PRODUCT_ID: "product-starter-annual", POLAR_PRO_MONTHLY_PRODUCT_ID: "product-pro-monthly", POLAR_PRO_ANNUAL_PRODUCT_ID: "product-pro-annual" };
const domain = { db: undefined as never };

type Answer = { method: string; path: string; status: number; body: unknown };
let recorded: Array<{ method: string; path: string; body: unknown }> = [];
let answers: Answer[] = [];

/** Polar answers this method and path with this status and body; anything else gets 200 and {}. */
function answer(method: string, path: string, body: unknown, status = 200): void {
  answers.push({ method, path, status, body });
}

function subscriptionBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "sub-1", status: "active", product_id: "product-starter-monthly", cancel_at_period_end: false, ended_at: null, pending_update: null, discount_id: null, current_period_end: "2099-12-01T00:00:00Z", ...extra };
}

function polar(): PolarBillingProvider {
  return new PolarBillingProvider({ accessToken: "polar-token", organizationId: "org-1", baseUrl: "https://polar.test" });
}

function job(type: JobEnvelope["type"], payload: Record<string, unknown>, queue: JobEnvelope["queue"] = "critical"): JobEnvelope {
  return { jobId: `job-${type}`, type, queue, businessId, payload, trace: {}, idempotencyKey: `test:${type}`, scheduled: false };
}

function checkoutRequest(extra: Record<string, unknown> = {}) {
  return { id: requestId, businessId, target: "starter" as const, billingInterval: "monthly" as const, status: "processing" as const, checkoutId: null, checkoutUrl: null, error: null, customerEmail: "owner@example.com", externalCustomerId: `business:${businessId}`, billingEmail: null, businessName: "Allo Salon", onboardingStage: "complete", planCode: null, subscription: null, ...extra };
}

beforeEach(() => {
  recorded = [];
  answers = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const { pathname, search } = new URL(String(url));
    const method = init?.method ?? "GET";
    recorded.push({ method, path: `${pathname}${search}`, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const found = answers.find((candidate) => candidate.method === method && candidate.path === pathname);
    return new Response(JSON.stringify(found?.body ?? {}), { status: found?.status ?? 200, headers: { "content-type": "application/json" } });
  }));
  for (const [key, value] of Object.entries(productEnv)) vi.stubEnv(key, value);
  vi.stubEnv("APP_BASE_URL", "https://app.example");
  vi.mocked(claimBillingCheckoutRequest).mockResolvedValue({ claimed: true });
  vi.mocked(markBillingCheckoutCreated).mockResolvedValue(true as never);
  vi.mocked(markBillingPlanChanged).mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  brand.appBaseUrl = null;
  vi.mocked(readPolarProductLinks).mockImplementation(async () => polarProductLinks({ plans: [], prices: [] }, process.env));
});

describe("the requests Polar receives", () => {
  describe("a checkout", () => {
    it("for a new customer", async () => {
      vi.mocked(loadBillingCheckoutRequest).mockResolvedValue(checkoutRequest());
      answer("GET", `/v1/customers/external/business%3A${businessId}`, { detail: "Not found" }, 404);
      answer("POST", "/v1/customers/", { id: "cus-new", external_id: `business:${businessId}` }, 201);
      answer("POST", "/v1/checkouts/", { id: "checkout-1", url: "https://polar.test/checkout/1" }, 201);
      await expect(handleJob(job("billing.createCheckout", { requestId }), { domain, billing: polarFake(polar()) })).resolves.toMatchObject({ status: "completed" });
      expect(recorded).toMatchSnapshot();
    });

    it("for a customer Polar has", async () => {
      vi.mocked(loadBillingCheckoutRequest).mockResolvedValue(checkoutRequest({ target: "pro", billingInterval: "annual" }));
      answer("GET", `/v1/customers/external/business%3A${businessId}`, { id: "cus-known", external_id: `business:${businessId}` });
      answer("POST", "/v1/checkouts/", { id: "checkout-2", url: "https://polar.test/checkout/2" }, 201);
      await expect(handleJob(job("billing.createCheckout", { requestId }), { domain, billing: polarFake(polar()) })).resolves.toMatchObject({ status: "completed" });
      expect(recorded).toMatchSnapshot();
    });

    it("with a billing email", async () => {
      vi.mocked(loadBillingCheckoutRequest).mockResolvedValue(checkoutRequest({ billingEmail: "billing@example.com", onboardingStage: "plan" }));
      answer("GET", `/v1/customers/external/business%3A${businessId}`, { detail: "Not found" }, 404);
      answer("POST", "/v1/customers/", { id: "cus-billing", external_id: `business:${businessId}` }, 201);
      answer("POST", "/v1/checkouts/", { id: "checkout-3", url: "https://polar.test/checkout/3" }, 201);
      await expect(handleJob(job("billing.createCheckout", { requestId }), { domain, billing: polarFake(polar()) })).resolves.toMatchObject({ status: "completed" });
      expect(recorded).toMatchSnapshot();
    });
  });

  describe("a plan change", () => {
    function change(input: { from: string; plan: "starter" | "pro"; target: "starter" | "pro"; billingInterval: "monthly" | "annual"; proration: { upgrade: "invoice" | "prorate"; downgrade: "next_period" } }) {
      vi.mocked(loadPlanChangeProration).mockResolvedValue(input.proration);
      vi.mocked(loadBillingCheckoutRequest).mockResolvedValue(checkoutRequest({ target: input.target, billingInterval: input.billingInterval, subscription: { id: "sub-1", plan: input.plan, billingInterval: "monthly", planCode: null } }));
      answer("GET", "/v1/subscriptions/sub-1", subscriptionBody({ product_id: input.from }));
      answer("PATCH", "/v1/subscriptions/sub-1", subscriptionBody({ product_id: input.from }));
      return handleJob(job("billing.createCheckout", { requestId }), { domain, billing: polarFake(polar()) });
    }

    it("an upgrade invoiced now", async () => {
      await expect(change({ from: "product-starter-monthly", plan: "starter", target: "pro", billingInterval: "annual", proration: { upgrade: "invoice", downgrade: "next_period" } })).resolves.toMatchObject({ status: "completed" });
      expect(recorded).toMatchSnapshot();
    });

    it("an upgrade prorated on the next invoice", async () => {
      await expect(change({ from: "product-starter-monthly", plan: "starter", target: "pro", billingInterval: "monthly", proration: { upgrade: "prorate", downgrade: "next_period" } })).resolves.toMatchObject({ status: "completed" });
      expect(recorded).toMatchSnapshot();
    });

    it("a downgrade from the next period", async () => {
      await expect(change({ from: "product-pro-monthly", plan: "pro", target: "starter", billingInterval: "monthly", proration: { upgrade: "invoice", downgrade: "next_period" } })).resolves.toMatchObject({ status: "completed" });
      expect(recorded).toMatchSnapshot();
    });
  });

  describe("a promo plan", () => {
    const promoPrice = { plan: "salons-half-off", tier: "starter", status: "active", period: "monthly" as const, currency: "cad", cents: 3000, per_month: 3000, polar_id: "promo-starter-monthly", retired: false };
    const planEnds = new Date("2099-11-25T00:00:00Z");
    const work = (extra: Partial<PromoEndWork> = {}): PromoEndWork => ({ planCode: "salons-half-off", planEnds, tier: "starter", interval: "monthly", subscriptionId: "sub-1", ending: "tier", endsAt: planEnds, set: true, notify: true, overdue: false, ...extra });

    beforeEach(() => {
      vi.mocked(readPolarProductLinks).mockImplementation(async () => polarProductLinks({ plans: [], prices: [promoPrice], others: [{ code: "salons-half-off", tier: "starter", status: "active", polar_disc: "disc-half-off" }] } as never, process.env));
      vi.mocked(recordPromoEnd).mockResolvedValue(1);
    });

    it("ending on its tier's standard product", async () => {
      vi.mocked(loadPromoEndWork).mockResolvedValue(work());
      answer("GET", "/v1/subscriptions/sub-1", subscriptionBody({ product_id: "promo-starter-monthly", discount_id: "disc-half-off" }));
      answer("PATCH", "/v1/subscriptions/sub-1", subscriptionBody({ product_id: "promo-starter-monthly", discount_id: "disc-half-off" }));
      await expect(handleJob(job("billing.endPromoPlan", {}, "default"), { domain, billing: polarFake(polar()) })).resolves.toMatchObject({ status: "completed" });
      expect(recorded).toMatchSnapshot();
    });

    it("ending with a cancellation", async () => {
      vi.mocked(loadPromoEndWork).mockResolvedValue(work({ ending: "cancel" }));
      answer("GET", "/v1/subscriptions/sub-1", subscriptionBody({ product_id: "promo-starter-monthly", discount_id: "disc-half-off" }));
      answer("PATCH", "/v1/subscriptions/sub-1", subscriptionBody({ product_id: "promo-starter-monthly", cancel_at_period_end: true }));
      await expect(handleJob(job("billing.endPromoPlan", {}, "default"), { domain, billing: polarFake(polar()) })).resolves.toMatchObject({ status: "completed" });
      expect(recorded).toMatchSnapshot();
    });

    it("its discount dropped from a standard product", async () => {
      answer("GET", "/v1/subscriptions/sub-1", subscriptionBody({ product_id: "product-starter-monthly", discount_id: "disc-half-off" }));
      answer("PATCH", "/v1/subscriptions/sub-1", subscriptionBody({ product_id: "product-starter-monthly" }));
      await expect(handleJob(job("billing.endPromoPlan", { dropDiscount: "disc-half-off", subscriptionId: "sub-1" }, "default"), { domain, billing: polarFake(polar()) })).resolves.toMatchObject({ status: "completed" });
      expect(recorded).toMatchSnapshot();
    });
  });

  it("ending a deleted business's plan", async () => {
    vi.mocked(recordDeletedBusinessPlanEnded).mockResolvedValue(undefined as never);
    answer("DELETE", "/v1/subscriptions/sub-1", subscriptionBody({ status: "canceled", ended_at: "2099-11-08T00:00:00Z" }));
    answer("GET", "/v1/subscriptions/sub-1", subscriptionBody({ status: "canceled", ended_at: "2099-11-08T00:00:00Z" }));
    await expect(handleJob(job("billing.revokeSubscription", { subscriptionId: "sub-1" }), { domain, billing: polarFake(polar()) })).resolves.toMatchObject({ status: "completed" });
    expect(recorded).toMatchSnapshot();
  });

  describe("usage", () => {
    function usageEvent(extra: Record<string, unknown>) {
      return { id: "usage-1", sourceKey: "source-1", isFinal: true, plan: "starter", businessId, usageKind: "alert_sms_segments", quantity: 2, billableQuantity: null, billingIntervalAtRecordTime: null, createdAt: new Date("2026-01-01T00:00:00.000Z"), syncStatus: "pending", billingKey: "business-key", customerId: "polar-customer-id", ...extra };
    }

    it("a row, then a correction as its difference", async () => {
      vi.mocked(loadBillingUsageEvent).mockResolvedValue(usageEvent({}) as never);
      vi.mocked(confirmBillingUsageSync).mockResolvedValue(true);
      vi.mocked(claimBillingUsageSync).mockResolvedValueOnce({ externalId: "alert_sms:operator_notification:delivery-1", quantity: 2, seq: 0 }).mockResolvedValueOnce({ externalId: "alert_sms:operator_notification:delivery-1:2", quantity: -1, seq: 2 });
      await handleJob(job("billing.syncUsage", { usageEventId: "usage-1" }), { domain, billing: polarFake(polar()) });
      await handleJob(job("billing.syncUsage", { usageEventId: "usage-1" }), { domain, billing: polarFake(polar()) });
      expect(recorded).toMatchSnapshot();
    });

    it("a call's seconds", async () => {
      vi.mocked(loadBillingUsageEvent).mockResolvedValue(usageEvent({ usageKind: "voice_seconds", quantity: 95, plan: "pro" }) as never);
      vi.mocked(confirmBillingUsageSync).mockResolvedValue(true);
      vi.mocked(claimBillingUsageSync).mockResolvedValueOnce({ externalId: "voice:call-1", quantity: 95, seq: 0 });
      await handleJob(job("billing.syncUsage", { usageEventId: "usage-1" }), { domain, billing: polarFake(polar()) });
      expect(recorded).toMatchSnapshot();
    });
  });
});
