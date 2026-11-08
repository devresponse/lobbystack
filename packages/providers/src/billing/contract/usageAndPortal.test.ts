import { afterEach, describe, expect, it, vi } from "vitest";

import { polarHarness, stripeHarness } from "./harness";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the billing provider contract: usage and the billing portal", () => {
  describe("on Polar", () => {
    it("sends each usage event to its meter, a call's seconds as minutes, and ignores the price", async () => {
      const polar = polarHarness();
      const customer = { id: "cus-1", billingKey: "business:b1" };
      const occurredAt = new Date("2026-01-01T00:00:00Z");
      await expect(polar.billing.reportUsage({ customer, businessId: "b1", kind: "voice", units: 90, amountCents: 30, occurredAt, identifier: "voice:call-1" })).resolves.toBe("sent");
      await polar.billing.reportUsage({ customer, businessId: "b1", kind: "alert_sms", units: 2, amountCents: null, occurredAt, identifier: "sms:1" });
      await polar.billing.reportUsage({ customer, businessId: "b1", kind: "transfer", units: 1, amountCents: null, occurredAt, identifier: "transfer:1" });
      expect(polar.requests.map((request) => (request.body as { events: unknown[] }).events[0])).toEqual([
        { name: "billing.voice_minutes", external_customer_id: "business:b1", external_id: "voice:call-1", timestamp: "2026-01-01T00:00:00.000Z", metadata: { quantity: 1.5, businessId: "b1", usageKind: "voice_seconds" } },
        { name: "billing.alert_sms_segments", external_customer_id: "business:b1", external_id: "sms:1", timestamp: "2026-01-01T00:00:00.000Z", metadata: { quantity: 2, businessId: "b1", usageKind: "alert_sms_segments" } },
        { name: "billing.outbound_call_attempts", external_customer_id: "business:b1", external_id: "transfer:1", timestamp: "2026-01-01T00:00:00.000Z", metadata: { quantity: 1, businessId: "b1", usageKind: "outbound_call_attempts" } },
      ]);
    });

    it("opens the billing portal for the business's customer by its billing key", async () => {
      const polar = polarHarness();
      polar.answer("POST", "/v1/customer-sessions/", { customer_portal_url: "https://polar.test/portal/1" }, 201);
      await expect(polar.billing.createPortalSession({ customer: { id: "cus-1", billingKey: "business:b1" }, returnUrl: "https://app.example/settings/plan", locale: "fr" })).resolves.toEqual({ url: "https://polar.test/portal/1" });
      expect(polar.requests).toEqual([{ method: "POST", path: "/v1/customer-sessions/", body: { external_customer_id: "business:b1", return_url: "https://app.example/settings/plan" } }]);
    });
  });

  describe("on Stripe", () => {
    it("opens the billing portal for the business's customer, with the deployment's configuration once a link recorded one", async () => {
      const { billing, stripe } = stripeHarness({ portalConfiguration: "bpc_1" });
      stripe.addCustomer({ id: "cus_1", businessId: "b1" });
      await expect(billing.createPortalSession({ customer: { id: "cus_1", billingKey: "business:b1" }, returnUrl: "https://app.example/settings/plan", locale: "fr" })).resolves.toEqual({ url: expect.stringMatching(/^https:\/\/billing\.stripe\.com\//) });
      expect(stripe.requests).toEqual([{ call: "billingPortal.sessions.create", params: { customer: "cus_1", return_url: "https://app.example/settings/plan", configuration: "bpc_1", locale: "fr" }, idempotencyKey: null }]);
    });

    it("lets Stripe pick the portal's language from the browser for one it doesn't have", async () => {
      const { billing, stripe } = stripeHarness();
      stripe.addCustomer({ id: "cus_1", businessId: "b1" });
      await billing.createPortalSession({ customer: { id: "cus_1", billingKey: "business:b1" }, returnUrl: "https://app.example/settings/plan", locale: "sr" });
      expect(stripe.requests).toEqual([{ call: "billingPortal.sessions.create", params: { customer: "cus_1", return_url: "https://app.example/settings/plan" }, idempotencyKey: null }]);
    });

    it("opens none for a business that has no customer yet", async () => {
      const { billing } = stripeHarness();
      await expect(billing.createPortalSession({ customer: { id: null, billingKey: "business:b1" }, returnUrl: "https://app.example", locale: null })).rejects.toMatchObject({ code: "not_found" });
    });

    /** An account with the three overage meters, as pnpm billing makes them, and the business's customer. */
    function withMeters() {
      const harness = stripeHarness();
      harness.stripe.addCustomer({ id: "cus_1", businessId: "b1" });
      harness.stripe.loadCatalog({ meters: [["voice", "ls_overage_voice"], ["alert_sms", "ls_overage_sms"], ["transfer", "ls_overage_transfers"]].map(([kind, event]) => ({ id: `mtr_${kind}`, display_name: kind!, event_name: event!, status: "active", default_aggregation: { formula: "sum" }, customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" }, value_settings: { event_payload_key: "value" } })) });
      return harness;
    }
    const usage = { customer: { id: "cus_1", billingKey: "business:b1" }, businessId: "b1", units: 90, occurredAt: new Date("2026-11-08T10:15:30Z") };

    it("sends each usage event to its kind's money meter, in dollars, dated as given, and takes a repeated identifier as a duplicate", async () => {
      const { billing, stripe } = withMeters();
      await expect(billing.reportUsage({ ...usage, kind: "voice", amountCents: 30.5, identifier: "voice:call-1" })).resolves.toBe("sent");
      expect(stripe.requests.at(-1)).toEqual({ call: "billing.meterEvents.create", params: { event_name: "ls_overage_voice", payload: { stripe_customer_id: "cus_1", value: "0.305000" }, identifier: "voice:call-1", timestamp: Date.parse("2026-11-08T10:15:30Z") / 1000 }, idempotencyKey: null });
      await expect(billing.reportUsage({ ...usage, kind: "voice", amountCents: 30.5, identifier: "voice:call-1" })).resolves.toBe("duplicate");
      // A correction's negative amount is an event too.
      await billing.reportUsage({ ...usage, kind: "alert_sms", amountCents: -7, identifier: "alert_sms:delivery-1:1" });
      expect(stripe.state.meterEvents.map((event) => [event.event_name, event.value])).toEqual([["ls_overage_voice", 0.305], ["ls_overage_sms", -0.07]]);
      // Usage needs a customer and a price.
      await expect(billing.reportUsage({ ...usage, customer: { id: null, billingKey: "business:b1" }, kind: "voice", amountCents: 1, identifier: "voice:2" })).rejects.toMatchObject({ code: "not_found" });
      await expect(billing.reportUsage({ ...usage, kind: "voice", amountCents: null, identifier: "voice:3" })).rejects.toMatchObject({ code: "refused" });
    });

    it("totals the customer's meters for a stretch of time in cents, and the credits corrections gave, once each", async () => {
      const { billing, stripe } = withMeters();
      await billing.reportUsage({ ...usage, kind: "voice", amountCents: 120, identifier: "voice:1" });
      await billing.reportUsage({ ...usage, kind: "voice", amountCents: 0.0004, identifier: "voice:2" });
      await billing.reportUsage({ ...usage, kind: "transfer", amountCents: 50, occurredAt: new Date("2026-10-31T23:59:00Z"), identifier: "transfer:1" });
      await expect(billing.usageTotals({ customerId: "cus_1", from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-08T11:00:00Z") })).resolves.toEqual({ voice: 120.0004, alert_sms: 0, transfer: 0 });
      await expect(billing.usageTotals({ customerId: "cus_1", from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-08T11:00:00Z") })).resolves.toEqual({ voice: 120.0004, alert_sms: 0, transfer: 50 });
      await billing.creditBalance({ customerId: "cus_1", kind: "voice", cents: 249.6, currency: "cad", identifier: "credit:b1:2026-11:voice:3" });
      await billing.creditBalance({ customerId: "cus_1", kind: "voice", cents: 249.6, currency: "cad", identifier: "credit:b1:2026-11:voice:3" });
      expect(stripe.state.balanceTransactions).toMatchObject([{ amount: -250, currency: "cad", metadata: { lobbystack_role: "usage_credit", lobbystack_overage: "voice" } }]);
      await expect(billing.usageCredits({ customerId: "cus_1" })).resolves.toEqual({ voice: 250, alert_sms: 0, transfer: 0 });
    });

    it("says which currency a customer is billed in, which a credit must match, and none for one that's gone", async () => {
      const { billing, stripe } = withMeters();
      stripe.addCustomer({ id: "cus_abroad", businessId: "b2", currency: "usd" });
      stripe.addCustomer({ id: "cus_gone", deleted: true });
      await expect(billing.customerCurrency("cus_abroad")).resolves.toBe("usd");
      await expect(billing.customerCurrency("cus_gone")).resolves.toBeNull();
      // A customer not billed yet has no currency.
      await expect(billing.customerCurrency("cus_1")).resolves.toBeNull();
    });
  });
});
