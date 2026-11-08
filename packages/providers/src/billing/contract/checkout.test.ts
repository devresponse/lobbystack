import { afterEach, describe, expect, it, vi } from "vitest";

import type Stripe from "stripe";

import type { StripeCatalogPrice } from "../../stripe/catalog";
import { polarHarness, stripeHarness, type StripeHarness } from "./harness";

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

  describe("on Stripe", () => {
    /** The account's plan and overage prices, as pnpm billing makes them. */
    function withCatalog() {
      const harness = stripeHarness();
      const { stripe } = harness;
      stripe.addCustomer({ id: "cus_1", businessId: "b1" });
      const price = (id: string, lookupKey: string, extra: Partial<StripeCatalogPrice> = {}): StripeCatalogPrice => ({ id, active: true, product: "prod_1", currency: "cad", unit_amount: 3700, lookup_key: lookupKey, tax_behavior: "exclusive", recurring: { interval: "month", interval_count: 1, usage_type: "licensed", meter: null }, metadata: {}, created: 1, ...extra });
      const metered = (kind: string) => price(`price_overage_${kind}`, `ls_overage_${kind}_cad`, { unit_amount: 100, recurring: { interval: "month", interval_count: 1, usage_type: "metered", meter: `mtr_${kind}` } });
      stripe.loadCatalog({
        products: [{ id: "prod_1", name: "Starter", active: true, metadata: {}, tax_code: "txcd_10103001", created: 1 }],
        prices: [price("price_starter_month", "ls_realinfobot_starter_monthly_cad_ec44c083"), metered("voice"), metered("sms"), metered("transfers")],
        meters: ["voice", "sms", "transfers"].map((kind) => ({ id: `mtr_${kind}`, display_name: kind, event_name: `ls_overage_${kind}`, status: "active", default_aggregation: { formula: "sum" }, customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" }, value_settings: { event_payload_key: "value" } })),
      });
      return harness;
    }

    /** The plan's overage subscription in CAD, made or found. */
    async function overageOf(billing: StripeHarness["billing"], planSubscriptionId: string): Promise<{ subscriptionId: string }> {
      const result = await billing.ensureOverage({ customerId: "cus_1", planSubscriptionId, businessId: "b1", currency: "cad" });
      if (!("subscriptionId" in result)) throw new Error(`The overage subscription ${result.unpaidSubscriptionId} is unpaid.`);
      return result;
    }

    it("makes a checkout on the business's customer: the plan's price and coupon, the request on the session and its subscription, an hour, Stripe Tax and the address it needs", async () => {
      vi.useFakeTimers({ now: new Date("2026-11-08T10:00:30Z") });
      try {
        const { billing, stripe } = withCatalog();
        const made = await billing.createCheckout({ ...base, locale: "fr", customer: { id: "cus_1", billingKey: "business:b1" }, price: { ref: "price_starter_month", discountRef: "ls-realinfobot-launch-12345678" } });
        expect(made).toEqual({ id: expect.stringMatching(/^cs_/), url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//), expiresAt: new Date("2026-11-08T11:01:00Z") });
        const metadata = { lobbystack_business: "b1", lobbystack_checkout: "request-1", lobbystack_role: "plan" };
        expect(stripe.requests.at(-1)).toEqual({
          call: "checkout.sessions.create",
          params: { mode: "subscription", line_items: [{ price: "price_starter_month", quantity: 1 }], discounts: [{ coupon: "ls-realinfobot-launch-12345678" }], customer: "cus_1", customer_update: { address: "auto", name: "auto" }, client_reference_id: "request-1", metadata, subscription_data: { metadata }, expires_at: Date.parse("2026-11-08T11:01:00Z") / 1000, success_url: base.successUrl, cancel_url: base.cancelUrl, locale: "fr", automatic_tax: { enabled: true }, billing_address_collection: "required", tax_id_collection: { enabled: true } },
          idempotencyKey: `checkout:request-1:${Date.parse("2026-11-08T11:01:00Z") / 1000}`,
        });
        // A retry within the minute gets the same page.
        await expect(billing.createCheckout({ ...base, locale: "fr", customer: { id: "cus_1", billingKey: "business:b1" }, price: { ref: "price_starter_month", discountRef: "ls-realinfobot-launch-12345678" } })).resolves.toEqual(made);
        expect(stripe.state.checkoutSessions.size).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("makes the overage subscription once, anchored on the 1st, on the checkout's card, and finds it again", async () => {
      const { billing, stripe } = withCatalog();
      const checkout = await billing.createCheckout({ ...base, customer: { id: "cus_1", billingKey: "business:b1" }, price: { ref: "price_starter_month", discountRef: null } });
      const plan = stripe.completeCheckout(checkout.id, { card: "pm_card_1" });
      const overage = await overageOf(billing, plan.id);
      const made = stripe.state.subscriptions.get(overage.subscriptionId)!;
      expect(made.metadata).toEqual({ lobbystack_business: "b1", lobbystack_role: "overage", lobbystack_plan_subscription: plan.id });
      expect(made.items.data.map((item) => item.price.id)).toEqual(["price_overage_voice", "price_overage_sms", "price_overage_transfers"]);
      expect(new Date(made.billing_cycle_anchor * 1000).toISOString()).toBe("2026-12-01T00:00:00.000Z");
      expect(stripe.requests.find((request) => request.call === "subscriptions.create")).toMatchObject({ params: { billing_cycle_anchor_config: { day_of_month: 1, hour: 0, minute: 0, second: 0 }, proration_behavior: "none", automatic_tax: { enabled: true } }, idempotencyKey: `overage:${plan.id}:0` });
      // The card is the customer's now, and both subscriptions pay with it.
      expect((stripe.state.customers.get("cus_1") as { invoice_settings?: { default_payment_method?: string } }).invoice_settings?.default_payment_method).toBe("pm_card_1");
      expect(stripe.state.subscriptions.get(plan.id)!.default_payment_method).toBeNull();
      // A retry, as after a job that died before storing it, finds the same one, and takes back an end set with the plan's.
      await billing.endOverage!({ subscriptionId: overage.subscriptionId, when: "period_end" });
      expect(stripe.state.subscriptions.get(overage.subscriptionId)!.cancel_at_period_end).toBe(true);
      await expect(billing.ensureOverage!({ customerId: "cus_1", planSubscriptionId: plan.id, businessId: "b1", currency: "cad" })).resolves.toEqual(overage);
      expect(stripe.state.subscriptions.get(overage.subscriptionId)!.cancel_at_period_end).toBe(false);
      expect([...stripe.state.subscriptions.values()].filter((subscription) => subscription.metadata.lobbystack_role === "overage")).toHaveLength(1);
    });

    it("ends the overage subscription with its usage invoiced, once, and refuses one without the overage prices", async () => {
      const { billing, stripe } = withCatalog();
      const checkout = await billing.createCheckout({ ...base, customer: { id: "cus_1", billingKey: "business:b1" }, price: { ref: "price_starter_month", discountRef: null } });
      const plan = stripe.completeCheckout(checkout.id);
      const overage = await overageOf(billing, plan.id);
      await billing.endOverage!({ subscriptionId: overage.subscriptionId, when: "now" });
      expect(stripe.state.subscriptions.get(overage.subscriptionId)!.status).toBe("canceled");
      expect([...stripe.state.invoices.values()].map((invoice) => invoice.parent?.subscription_details?.subscription)).toEqual([overage.subscriptionId]);
      // Ending it again, or one Stripe doesn't have, is done already.
      await expect(billing.endOverage!({ subscriptionId: overage.subscriptionId, when: "period_end" })).resolves.toBeUndefined();
      await expect(billing.endOverage!({ subscriptionId: "sub_gone", when: "now" })).resolves.toBeUndefined();
      await expect(billing.ensureOverage!({ customerId: "cus_1", planSubscriptionId: plan.id, businessId: "b1", currency: "usd" })).rejects.toMatchObject({ code: "not_found", message: expect.stringContaining("Run pnpm billing apply --stripe") });
    });

    it("doesn't replace one Stripe ended after failed payments while its invoice is open, and does once it's collected or forgiven", async () => {
      const { billing, stripe } = withCatalog();
      const checkout = await billing.createCheckout({ ...base, customer: { id: "cus_1", billingKey: "business:b1" }, price: { ref: "price_starter_month", discountRef: null } });
      const plan = stripe.completeCheckout(checkout.id);
      const first = await overageOf(billing, plan.id);
      // Stripe's last retry failed, and it ended the subscription with the invoice open.
      const invoice = { id: "in_overage", object: "invoice", status: "open" } as Stripe.Invoice;
      stripe.state.invoices.set(invoice.id, invoice);
      const failed = { ...stripe.state.subscriptions.get(first.subscriptionId)!, status: "canceled", cancellation_details: { comment: null, feedback: null, reason: "payment_failed" }, latest_invoice: invoice.id } as Stripe.Subscription;
      stripe.state.subscriptions.set(first.subscriptionId, failed);
      await expect(billing.ensureOverage({ customerId: "cus_1", planSubscriptionId: plan.id, businessId: "b1", currency: "cad" })).resolves.toEqual({ unpaidSubscriptionId: first.subscriptionId });
      // One Stripe leaves unpaid is owing too.
      stripe.state.subscriptions.set(first.subscriptionId, { ...failed, status: "unpaid", cancellation_details: null } as Stripe.Subscription);
      await expect(billing.ensureOverage({ customerId: "cus_1", planSubscriptionId: plan.id, businessId: "b1", currency: "cad" })).resolves.toEqual({ unpaidSubscriptionId: first.subscriptionId });
      // The operator forgives the ended one's invoice: the plan gets a new overage subscription, under a key of its own.
      stripe.state.subscriptions.set(first.subscriptionId, failed);
      stripe.state.invoices.set(invoice.id, { ...invoice, status: "void" } as Stripe.Invoice);
      const second = await overageOf(billing, plan.id);
      expect(second.subscriptionId).not.toBe(first.subscriptionId);
      expect(stripe.requests.filter((request) => request.call === "subscriptions.create").map((request) => request.idempotencyKey)).toEqual([`overage:${plan.id}:0`, `overage:${plan.id}:1`]);
      // One canceled by hand is replaced at once.
      await billing.endOverage({ subscriptionId: second.subscriptionId, when: "now" });
      expect((await overageOf(billing, plan.id)).subscriptionId).not.toBe(second.subscriptionId);
    });
  });
});
