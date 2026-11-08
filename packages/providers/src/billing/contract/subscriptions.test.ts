import { afterEach, describe, expect, it, vi } from "vitest";

import { BillingProviderError } from "../errors";
import { polarHarness, polarSubscriptionBody, stripeHarness } from "./harness";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the billing provider contract: a subscription", () => {
  describe("on Polar", () => {
    it("reads one as the interface shows it, and null for one Polar doesn't know", async () => {
      const polar = polarHarness();
      polar.answer("GET", "/v1/subscriptions/sub-1", polarSubscriptionBody({ status: "past_due", product_id: "product-pro-monthly", discount_id: "disc-1", cancel_at_period_end: true, pending_update: { product_id: "product-starter-monthly" } }));
      const subscription = await polar.billing.getSubscription("sub-1");
      expect(subscription).toMatchObject({ id: "sub-1", state: "past_due", priceRef: "product-pro-monthly", discountRef: "disc-1", periodEnd: new Date("2099-12-01T00:00:00Z"), cancelAt: new Date("2099-12-01T00:00:00Z"), endedAt: null, next: { priceRef: "product-starter-monthly", at: new Date("2099-12-01T00:00:00Z") } });
      expect(subscription?.readAt).toBeInstanceOf(Date);

      polar.answer("GET", "/v1/subscriptions/sub-2", { detail: "Not found" }, 404);
      await expect(polar.billing.getSubscription("sub-2")).resolves.toBeNull();
    });

    it("maps Polar's states, an expired incomplete one as ended", async () => {
      const polar = polarHarness();
      const states: Record<string, string> = {};
      for (const status of ["incomplete", "incomplete_expired", "trialing", "active", "past_due", "unpaid", "canceled"]) {
        polar.answer("GET", `/v1/subscriptions/${status}`, polarSubscriptionBody({ id: status, status, ended_at: status === "canceled" ? "2099-01-01T00:00:00Z" : null }));
        states[status] = (await polar.billing.getSubscription(status))!.state;
      }
      expect(states).toEqual({ incomplete: "incomplete", incomplete_expired: "ended", trialing: "trialing", active: "active", past_due: "past_due", unpaid: "unpaid", canceled: "canceled" });
    });

    it("changes a plan with billing.json's proration words, and its discount only when asked", async () => {
      const polar = polarHarness();
      polar.answer("PATCH", "/v1/subscriptions/sub-1", polarSubscriptionBody());
      const to = { ref: "product-pro-monthly", discountRef: null };
      await expect(polar.billing.changePlan({ subscriptionId: "sub-1", to, discount: "keep", when: "now", proration: "invoice_now", requestId: "r1" })).resolves.toMatchObject({ status: "changed" });
      await polar.billing.changePlan({ subscriptionId: "sub-1", to, discount: "keep", when: "now", proration: "next_invoice", requestId: "r2" });
      await expect(polar.billing.changePlan({ subscriptionId: "sub-1", to, discount: "remove", when: "renewal", proration: "none", requestId: "r3" })).resolves.toMatchObject({ status: "scheduled" });
      await polar.billing.changePlan({ subscriptionId: "sub-1", to: { ref: "promo-pro-monthly", discountRef: "disc-1" }, discount: "price", when: "now", proration: "restart", metadata: { lobbystack_plan: "pro-launch" }, requestId: "r4" });
      expect(polar.requests.map((request) => request.body)).toEqual([
        { product_id: "product-pro-monthly", proration_behavior: "invoice" },
        { product_id: "product-pro-monthly", proration_behavior: "prorate" },
        { product_id: "product-pro-monthly", proration_behavior: "next_period", discount_id: null },
        { product_id: "promo-pro-monthly", proration_behavior: "reset", discount_id: "disc-1", metadata: { lobbystack_plan: "pro-launch" } },
      ]);
      await expect(polar.billing.changePlan({ subscriptionId: "sub-1", to, discount: "keep", when: "now", proration: "none", requestId: "r5" })).rejects.toBeInstanceOf(BillingProviderError);
    });

    it("ends a promo plan at the renewal: on its tier's product without the discount, or cancelled", async () => {
      const polar = polarHarness();
      polar.answer("PATCH", "/v1/subscriptions/sub-1", polarSubscriptionBody());
      await polar.billing.endAtRenewal({ subscriptionId: "sub-1", then: { ref: "product-starter-monthly", discountRef: null }, requestId: "r1" });
      await polar.billing.endAtRenewal({ subscriptionId: "sub-1", then: "cancel", requestId: "r2" });
      expect(polar.requests.map((request) => request.body)).toEqual([
        { product_id: "product-starter-monthly", proration_behavior: "next_period", discount_id: null },
        { cancel_at_period_end: true },
      ]);
    });

    it("removes a discount from the next billing cycle on", async () => {
      const polar = polarHarness();
      polar.answer("PATCH", "/v1/subscriptions/sub-1", polarSubscriptionBody());
      await polar.billing.removeDiscount({ subscriptionId: "sub-1", requestId: "r1" });
      expect(polar.requests).toEqual([{ method: "PATCH", path: "/v1/subscriptions/sub-1", body: { discount_id: null } }]);
    });

    it("ends one now, counting one Polar no longer has or that already ended as ended", async () => {
      for (const [status, body] of [[200, polarSubscriptionBody({ status: "canceled" })], [404, { detail: "Not found" }], [403, { error: "AlreadyCanceledSubscription" }]] as const) {
        const polar = polarHarness();
        polar.answer("DELETE", "/v1/subscriptions/sub-1", body, status);
        await expect(polar.billing.revoke({ subscriptionId: "sub-1", requestId: "r1" })).resolves.toBe("ended");
        vi.unstubAllGlobals();
      }
      const now = polarHarness();
      await expect(now.billing.cancel({ subscriptionId: "sub-1", when: "now", requestId: "r2" })).resolves.toBeNull();
      expect(now.requests.map((request) => request.method)).toEqual(["DELETE"]);
    });

    it("leaves resuming and keeping a plan to Polar's billing portal", async () => {
      const polar = polarHarness();
      await expect(polar.billing.resume({ subscriptionId: "sub-1", requestId: "r1" })).rejects.toMatchObject({ code: "not_supported" });
      await expect(polar.billing.keepPlan({ subscriptionId: "sub-1", requestId: "r1" })).rejects.toMatchObject({ code: "not_supported" });
      expect(polar.billing.can.inAppCancel).toBe(false);
      expect(polar.requests).toEqual([]);
    });
  });

  describe("on Stripe", () => {
    it("reads one with its schedule, discounts and latest invoice, and null for one Stripe doesn't know", async () => {
      const { billing, stripe } = stripeHarness();
      stripe.addSubscription({ id: "sub_1", customer: "cus_1", status: "past_due", price: "price_pro_monthly", coupon: "coupon_1", cancelAtPeriodEnd: true, periodEnd: 4_100_000_000 });
      const subscription = await billing.getSubscription("sub_1");
      expect(subscription).toMatchObject({ id: "sub_1", customerId: "cus_1", state: "past_due", priceRef: "price_pro_monthly", discountRef: "coupon_1", periodEnd: new Date(4_100_000_000_000), cancelAt: new Date(4_100_000_000_000) });
      expect(stripe.requests[0]).toEqual({ call: "subscriptions.retrieve", params: { id: "sub_1", expand: ["schedule", "discounts", "latest_invoice"] }, idempotencyKey: null });
      await expect(billing.getSubscription("sub_2")).resolves.toBeNull();
    });

    it("ends one now, invoicing what it owes with no proration, once for a retried job", async () => {
      const { billing, stripe } = stripeHarness();
      stripe.addSubscription({ id: "sub_1", customer: "cus_1" });
      await expect(billing.revoke({ subscriptionId: "sub_1", requestId: "r1" })).resolves.toBe("ended");
      expect(stripe.requests).toEqual([{ call: "subscriptions.cancel", params: { id: "sub_1", invoice_now: true, prorate: false }, idempotencyKey: "revoke:sub_1" }]);
      expect(stripe.state.subscriptions.get("sub_1")?.status).toBe("canceled");
      expect(stripe.state.invoices.size).toBe(1);
      // The same job again: Stripe answers the key's first answer.
      await expect(billing.revoke({ subscriptionId: "sub_1", requestId: "r1" })).resolves.toBe("ended");
      expect(stripe.state.invoices.size).toBe(1);
    });

    it("counts one Stripe no longer has, or that already ended, as ended", async () => {
      const { billing, stripe } = stripeHarness();
      await expect(billing.revoke({ subscriptionId: "sub_gone", requestId: "r1" })).resolves.toBe("already_ended");
      stripe.addSubscription({ id: "sub_ended", status: "canceled", endedAt: 1 });
      await expect(billing.revoke({ subscriptionId: "sub_ended", requestId: "r1" })).resolves.toBe("already_ended");
    });

    it("answers not_supported, naming the step, for the flows later steps add", async () => {
      const { billing, stripe } = stripeHarness();
      await expect(billing.cancel({ subscriptionId: "sub_1", when: "renewal", requestId: "r1" })).rejects.toMatchObject({ code: "not_supported", message: expect.stringContaining("step 15") });
      await expect(billing.resume({ subscriptionId: "sub_1", requestId: "r1" })).rejects.toMatchObject({ code: "not_supported" });
      await expect(billing.keepPlan({ subscriptionId: "sub_1", requestId: "r1" })).rejects.toMatchObject({ code: "not_supported" });
      expect(stripe.requests).toEqual([]);
      expect(billing.can).toEqual({ uniqueCustomerEmail: false, meterMoney: true, separateOverage: true, readBack: true, inAppCancel: true });
    });
  });
});
