import { afterEach, describe, expect, it, vi } from "vitest";

import { polarHarness } from "./harness";

const base = { email: "owner@example.com", businessId: "b1", requestId: "request-1", metadata: { lobbystack_business: "b1" }, successUrl: "https://app.example/settings/plan?checkout=success", cancelUrl: "https://app.example/settings/plan", locale: null };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the billing provider contract: checkout", () => {
  describe("on Polar", () => {
    it("makes a checkout out to the customer, returning to the plan page", async () => {
      const polar = polarHarness();
      polar.answer("POST", "/v1/checkouts/", { id: "checkout-1", url: "https://polar.test/checkout/1" }, 201);
      await expect(polar.billing.createCheckout({ ...base, customer: { id: "cus-1", billingKey: "business:b1" }, price: { ref: "product-starter-monthly", discountRef: null } })).resolves.toEqual({ id: "checkout-1", url: "https://polar.test/checkout/1", expiresAt: null });
      expect(polar.requests).toEqual([{ method: "POST", path: "/v1/checkouts/", body: { products: ["product-starter-monthly"], customer_id: "cus-1", success_url: base.successUrl, return_url: base.cancelUrl, allow_discount_codes: false, metadata: { lobbystack_business: "b1" } } }]);
    });

    it("names the email and billing key when the customer is Polar's to pick, and sells a promo plan with its discount", async () => {
      const polar = polarHarness();
      polar.answer("POST", "/v1/checkouts/", { id: "checkout-2", url: "https://polar.test/checkout/2" }, 201);
      await polar.billing.createCheckout({ ...base, customer: { id: null, billingKey: "business:b1" }, price: { ref: "promo-starter-monthly", discountRef: "disc-half-off" } });
      expect(polar.requests[0]?.body).toEqual({ products: ["promo-starter-monthly"], customer_email: "owner@example.com", external_customer_id: "business:b1", success_url: base.successUrl, return_url: base.cancelUrl, allow_discount_codes: false, discount_id: "disc-half-off", metadata: { lobbystack_business: "b1" } });
    });
  });
});
