import { afterEach, describe, expect, it, vi } from "vitest";

import { BillingProviderError } from "../errors";
import { polarHarness, polarSubscriptionBody } from "./harness";

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
});
