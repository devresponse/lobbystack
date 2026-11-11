import { afterEach, describe, expect, it, vi } from "vitest";

import type { StripeCatalogPrice } from "../../stripe/catalog";
import { polarHarness, stripeHarness } from "./harness";

// A prepaid pack's checkout on each provider: a one-time payment for the
// pack's price or product, with metadata that names the business, the pack
// checkout and the pack, so the payment's events find them.

const metadata = { lobbystack_business: "b1", lobbystack_pack: "minutes_500_90", lobbystack_pack_price: "price-row-1" };
const base = { email: "owner@example.com", businessId: "b1", checkoutId: "pack-checkout-1", metadata, successUrl: "https://app.example/settings/plan?pack=success&packCheckoutId=pack-checkout-1", cancelUrl: "https://app.example/settings/plan", locale: null };
const tagged = { ...metadata, lobbystack_pack_checkout: "pack-checkout-1", lobbystack_role: "pack" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the billing provider contract: a pack's checkout", () => {
  describe("on Polar", () => {
    it("makes a checkout for the pack's product, out to the customer, with the pack's metadata and no discount codes", async () => {
      const polar = polarHarness();
      polar.answer("POST", "/v1/checkouts/", { id: "checkout-1", url: "https://polar.test/checkout/1" }, 201);
      await expect(polar.billing.createPackCheckout({ ...base, customer: { id: "cus-1", billingKey: "business:b1" }, price: { ref: "product-pack-500-90" } })).resolves.toEqual({ id: "checkout-1", url: "https://polar.test/checkout/1", expiresAt: null });
      expect(polar.requests).toEqual([{ method: "POST", path: "/v1/checkouts/", body: { products: ["product-pack-500-90"], customer_id: "cus-1", success_url: base.successUrl, return_url: base.cancelUrl, allow_discount_codes: false, metadata: tagged } }]);
    });

    it("names the email and billing key when the customer is Polar's to pick", async () => {
      const polar = polarHarness();
      polar.answer("POST", "/v1/checkouts/", { id: "checkout-2", url: "https://polar.test/checkout/2" }, 201);
      await polar.billing.createPackCheckout({ ...base, customer: { id: null, billingKey: "business:b1" }, price: { ref: "product-pack-500-90" } });
      expect(polar.requests[0]?.body).toEqual({ products: ["product-pack-500-90"], customer_email: "owner@example.com", external_customer_id: "business:b1", success_url: base.successUrl, return_url: base.cancelUrl, allow_discount_codes: false, metadata: tagged });
    });

    it("has no call to close a page, so a page left open stays payable until its own expiry", () => {
      expect(polarHarness().billing.closePackCheckout).toBeUndefined();
    });
  });

  describe("on Stripe", () => {
    /** The account's one-time pack price, as pnpm billing makes it. */
    function withPack() {
      const harness = stripeHarness();
      harness.stripe.addCustomer({ id: "cus_1", businessId: "b1" });
      const price: StripeCatalogPrice = { id: "price_pack_500_90", active: true, product: "prod_pack", currency: "cad", unit_amount: 9900, lookup_key: "ls_pack_minutes_500_90_cad", tax_behavior: "exclusive", recurring: null, metadata: {}, created: 1 };
      harness.stripe.loadCatalog({ products: [{ id: "prod_pack", name: "500 minutes for 90 days", active: true, metadata: {}, tax_code: "txcd_10103001", created: 1 }], prices: [price] });
      return harness;
    }

    const expiresAt = Date.parse("2026-11-08T11:01:00Z") / 1000;

    it("sells it directly: payment mode on the business's customer, the metadata on the session, its payment and its invoice, an hour, Stripe Tax and the address it needs", async () => {
      vi.useFakeTimers({ now: new Date("2026-11-08T10:00:30Z") });
      const { billing, stripe } = withPack();
      const made = await billing.createPackCheckout({ ...base, locale: "fr", customer: { id: "cus_1", billingKey: "business:b1" }, price: { ref: "price_pack_500_90" } });
      expect(made).toEqual({ id: expect.stringMatching(/^cs_/), url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//), expiresAt: new Date("2026-11-08T11:01:00Z") });
      expect(stripe.requests.at(-1)).toEqual({
        call: "checkout.sessions.create",
        params: { mode: "payment", line_items: [{ price: "price_pack_500_90", quantity: 1 }], customer: "cus_1", customer_update: { address: "auto", name: "auto" }, client_reference_id: "pack-checkout-1", metadata: tagged, payment_intent_data: { metadata: tagged }, expires_at: expiresAt, success_url: base.successUrl, cancel_url: base.cancelUrl, locale: "fr", billing_address_collection: "required", automatic_tax: { enabled: true }, tax_id_collection: { enabled: true }, invoice_creation: { enabled: true, invoice_data: { metadata: tagged } } },
        idempotencyKey: `pack-checkout:pack-checkout-1:${expiresAt}`,
      });
      // A retry within the minute gets the same page.
      await expect(billing.createPackCheckout({ ...base, locale: "fr", customer: { id: "cus_1", billingKey: "business:b1" }, price: { ref: "price_pack_500_90" } })).resolves.toEqual(made);
      expect(stripe.state.checkoutSessions.size).toBe(1);

      // Paid: one PaymentIntent for the price with the pack's metadata, and the invoice it paid.
      const payment = stripe.completePaymentCheckout(made.id, { card: "pm_card_1" });
      expect(payment).toMatchObject({ object: "payment_intent", status: "succeeded", amount: 9900, currency: "cad", customer: "cus_1", metadata: tagged });
      expect(stripe.state.subscriptions.size).toBe(0);
      const invoiceId = await billing.invoiceOfPayment(payment.id);
      expect(stripe.state.invoices.get(invoiceId!)).toMatchObject({ status: "paid", amount_paid: 9900, metadata: tagged });
      expect(stripe.state.checkoutSessions.get(made.id)).toMatchObject({ status: "complete", payment_status: "paid", payment_intent: payment.id, invoice: invoiceId });
    });

    it("sells it with Stripe as the merchant of record: Managed Payments on, and the four parameters Stripe's guide leaves out left out", async () => {
      vi.useFakeTimers({ now: new Date("2026-11-08T10:00:30Z") });
      const { billing, stripe } = withPack();
      const made = await billing.createPackCheckout({ ...base, customer: { id: "cus_1", billingKey: "business:b1" }, price: { ref: "price_pack_500_90" }, merchantOfRecord: true });
      expect(stripe.requests.at(-1)).toEqual({
        call: "checkout.sessions.create",
        params: { mode: "payment", line_items: [{ price: "price_pack_500_90", quantity: 1 }], customer: "cus_1", client_reference_id: "pack-checkout-1", metadata: tagged, payment_intent_data: { metadata: tagged }, expires_at: expiresAt, success_url: base.successUrl, cancel_url: base.cancelUrl, billing_address_collection: "required", managed_payments: { enabled: true } },
        idempotencyKey: `pack-checkout:pack-checkout-1:${expiresAt}`,
      });
      // Paid: the PaymentIntent carries the metadata, and no invoice is made.
      const payment = stripe.completePaymentCheckout(made.id);
      expect(payment.metadata).toEqual(tagged);
      expect(stripe.state.invoices.size).toBe(0);
      await expect(billing.invoiceOfPayment(payment.id)).resolves.toBeNull();
    });

    it("closes an open page, so nobody can pay on it, and takes a page already paid, expired or unknown as closed", async () => {
      const { billing, stripe } = withPack();
      const open = await billing.createPackCheckout({ ...base, customer: { id: "cus_1", billingKey: "business:b1" }, price: { ref: "price_pack_500_90" } });
      await expect(billing.closePackCheckout!({ checkoutId: open.id })).resolves.toBe("closed");
      expect(stripe.requests.at(-1)).toEqual({ call: "checkout.sessions.expire", params: { id: open.id }, idempotencyKey: null });
      expect(stripe.state.checkoutSessions.get(open.id)).toMatchObject({ status: "expired" });
      // Stripe refuses to expire a session that isn't open; read back, it was closed already.
      await expect(billing.closePackCheckout!({ checkoutId: open.id })).resolves.toBe("already_closed");
      const paid = await billing.createPackCheckout({ ...base, checkoutId: "pack-checkout-2", customer: { id: "cus_1", billingKey: "business:b1" }, price: { ref: "price_pack_500_90" } });
      stripe.completePaymentCheckout(paid.id);
      await expect(billing.closePackCheckout!({ checkoutId: paid.id })).resolves.toBe("already_closed");
      expect(stripe.state.checkoutSessions.get(paid.id)).toMatchObject({ status: "complete", payment_status: "paid" });
      await expect(billing.closePackCheckout!({ checkoutId: "cs_unknown" })).resolves.toBe("already_closed");
    });

    it("never makes a subscription, and sells no plan's parameters in payment mode", async () => {
      const { billing, stripe } = withPack();
      const made = await billing.createPackCheckout({ ...base, customer: { id: "cus_1", billingKey: "business:b1" }, price: { ref: "price_pack_500_90" } });
      const params = stripe.requests.at(-1)!.params as Record<string, unknown>;
      for (const key of ["subscription_data", "discounts", "adaptive_pricing"]) expect(params).not.toHaveProperty(key);
      expect(() => stripe.completeCheckout(made.id)).toThrow("payment-mode session");
      // Stripe refuses each mode's parameters in the other, and so does the fake.
      await expect(stripe.checkout.sessions.create({ mode: "payment", line_items: [{ price: "price_pack_500_90", quantity: 1 }], subscription_data: { metadata: {} } })).rejects.toThrow("subscription_data");
      await expect(stripe.checkout.sessions.create({ mode: "subscription", line_items: [{ price: "price_pack_500_90", quantity: 1 }], payment_intent_data: { metadata: {} } })).rejects.toThrow("payment_intent_data");
    });
  });
});
