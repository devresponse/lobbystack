import { afterEach, describe, expect, it, vi } from "vitest";

import { polarHarness } from "./harness";

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
});
