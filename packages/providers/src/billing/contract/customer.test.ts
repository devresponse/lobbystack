import Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lobbystack/telemetry/node", async (importOriginal) => ({ ...await importOriginal<typeof import("@lobbystack/telemetry/node")>(), reportWarning: vi.fn() }));

import { reportWarning } from "@lobbystack/telemetry/node";
import { polarHarness, stripeHarness } from "./harness";

const input = { customer: { id: null, billingKey: "business:b1" }, businessId: "b1", email: "owner@example.com", name: "Allo Salon", locale: null, requestId: "request-1" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the billing provider contract: the customer", () => {
  describe("on Polar", () => {
    it("finds the business's customer by its billing key", async () => {
      const polar = polarHarness();
      polar.answer("GET", "/v1/customers/external/business%3Ab1", { id: "cus-1", external_id: "business:b1" });
      await expect(polar.billing.findOrCreateCustomer(input)).resolves.toEqual({ id: "cus-1", created: false });
      expect(polar.requests.map((request) => request.method)).toEqual(["GET"]);
    });

    it("makes one with the email and name when Polar has none", async () => {
      const polar = polarHarness();
      polar.answer("GET", "/v1/customers/external/business%3Ab1", { detail: "Not found" }, 404);
      polar.answer("POST", "/v1/customers/", { id: "cus-2", external_id: "business:b1" }, 201);
      await expect(polar.billing.findOrCreateCustomer(input)).resolves.toEqual({ id: "cus-2", created: true });
      expect(polar.requests[1]).toEqual({ method: "POST", path: "/v1/customers/", body: { external_id: "business:b1", email: "owner@example.com", name: "Allo Salon" } });
    });

    it("finds the one another run made first", async () => {
      const polar = polarHarness();
      // Polar has none at the first read, refuses the new one's billing key, then has the race's winner.
      let reads = 0;
      vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") !== "GET") return new Response(JSON.stringify({ detail: [{ loc: ["body", "external_id"], msg: "taken" }] }), { status: 422 });
        reads += 1;
        return reads === 1 ? new Response(JSON.stringify({ detail: "Not found" }), { status: 404 }) : new Response(JSON.stringify({ id: "cus-3", external_id: "business:b1" }), { status: 200 });
      }));
      await expect(polar.billing.findOrCreateCustomer(input)).resolves.toEqual({ id: "cus-3", created: false });
      expect(reads).toBe(2);
    });

    it("leaves the customer to checkout, with a warning, when the token can't read customers", async () => {
      const polar = polarHarness();
      polar.answer("GET", "/v1/customers/external/business%3Ab1", { error: "insufficient_scope" }, 403);
      await expect(polar.billing.findOrCreateCustomer(input)).resolves.toBeNull();
      expect(vi.mocked(reportWarning).mock.calls.map(([error]) => (error as Error).message)).toEqual([expect.stringContaining("customers:write")]);
    });

    it("refuses an email another customer has, and one Polar doesn't take as an email", async () => {
      const taken = polarHarness();
      taken.answer("GET", "/v1/customers/external/business%3Ab1", { detail: "Not found" }, 404);
      taken.answer("POST", "/v1/customers/", { error: "PolarRequestValidationError", detail: [{ loc: ["body", "email"], msg: "taken" }] }, 422);
      const takenError = await taken.billing.findOrCreateCustomer(input).catch((error: unknown) => error);
      expect(taken.billing.refusalFor(takenError)).toBe("billing_email_taken");

      const invalid = polarHarness();
      invalid.answer("GET", "/v1/customers/external/business%3Ab1", { detail: "Not found" }, 404);
      invalid.answer("POST", "/v1/customers/", { error: "RequestValidationError", detail: [{ loc: ["body", "email"], msg: "invalid" }] }, 422);
      const invalidError = await invalid.billing.findOrCreateCustomer(input).catch((error: unknown) => error);
      expect(invalid.billing.refusalFor(invalidError)).toBe("billing_email_invalid");
    });
  });

  describe("on Stripe", () => {
    it("makes the business's customer with its email, name, language and IDs, once for a retried job", async () => {
      const { billing, stripe } = stripeHarness();
      const made = await billing.findOrCreateCustomer({ ...input, locale: "fr" });
      expect(made).toEqual({ id: expect.stringMatching(/^cus_/), created: true });
      expect(stripe.requests).toEqual([{ call: "customers.create", params: { email: "owner@example.com", name: "Allo Salon", preferred_locales: ["fr"], metadata: { lobbystack_business: "b1", lobbystack_billing_key: "business:b1", lobbystack_deployment: "https://app.example" } }, idempotencyKey: "customer:b1" }]);
      // A retry with the same key gets the same customer.
      await expect(billing.findOrCreateCustomer({ ...input, locale: "fr" })).resolves.toEqual({ id: made.id, created: true });
      expect(stripe.state.customers.size).toBe(1);
    });

    it("leaves out a language Stripe's emails don't come in", async () => {
      const { billing, stripe } = stripeHarness();
      await billing.findOrCreateCustomer({ ...input, locale: "sr" });
      expect(stripe.requests[0]?.params).not.toHaveProperty("preferred_locales");
    });

    it("finds the business's customer by the ID the account holds", async () => {
      const { billing, stripe } = stripeHarness();
      stripe.addCustomer({ id: "cus_known", businessId: "b1" });
      await expect(billing.findOrCreateCustomer({ ...input, customer: { id: "cus_known", billingKey: "business:b1" } })).resolves.toEqual({ id: "cus_known", created: false });
      expect(stripe.requests.map((request) => request.call)).toEqual(["customers.retrieve"]);
    });

    it("makes a new one for a deleted customer, one naming another business, and one Stripe no longer has", async () => {
      for (const known of [{ id: "cus_old", deleted: true }, { id: "cus_old", businessId: "b2" }, null]) {
        const { billing, stripe } = stripeHarness();
        if (known) stripe.addCustomer(known);
        const made = await billing.findOrCreateCustomer({ ...input, customer: { id: "cus_old", billingKey: "business:b1" } });
        expect(made).toEqual({ id: expect.not.stringMatching(/^cus_old$/), created: true });
        expect(stripe.requests.at(-1)).toMatchObject({ call: "customers.create", idempotencyKey: "customer:b1:2" });
      }
    });

    it("keeps no customer per email, so a billing email is never refused", () => {
      expect(stripeHarness().billing.can.uniqueCustomerEmail).toBe(false);
    });

    it("names the business a pack's payment intent names, for a dispute, and none for any other payment", async () => {
      const { billing, stripe } = stripeHarness();
      const businessId = "4f0d7c43-8a54-4d7e-9b0f-3c1f1e2a9b11";
      const intent = (id: string, metadata: Record<string, string>) => ({ id, object: "payment_intent", status: "succeeded", metadata }) as never;
      stripe.state.paymentIntents.set("pi_pack", intent("pi_pack", { lobbystack_business: businessId, lobbystack_role: "pack", lobbystack_pack: "pack_500_90" }));
      stripe.state.paymentIntents.set("pi_plan", intent("pi_plan", { lobbystack_business: businessId }));
      stripe.state.paymentIntents.set("pi_bad", intent("pi_bad", { lobbystack_business: "not-a-business", lobbystack_role: "pack" }));
      await expect(billing.businessOfPackPayment!("pi_pack")).resolves.toBe(businessId);
      // A plan's payment, a pack naming no business, one Stripe no longer has, and a charge ID name none.
      await expect(billing.businessOfPackPayment!("pi_plan")).resolves.toBeNull();
      await expect(billing.businessOfPackPayment!("pi_bad")).resolves.toBeNull();
      await expect(billing.businessOfPackPayment!("pi_gone")).resolves.toBeNull();
      await expect(billing.businessOfPackPayment!("ch_1")).resolves.toBeNull();
      expect(stripe.requests.map((request) => request.call)).toEqual(["paymentIntents.retrieve", "paymentIntents.retrieve", "paymentIntents.retrieve", "paymentIntents.retrieve"]);
    });

    it("names no business, with a warning, when the admin's key can't read payment intents, and throws what Stripe may answer later", async () => {
      const { billing, stripe } = stripeHarness();
      const retrieve = vi.spyOn(stripe.paymentIntents, "retrieve");
      retrieve.mockRejectedValueOnce(new Stripe.errors.StripePermissionError({ type: "invalid_request_error", message: "The provided key does not have the required permissions for this endpoint. Having the 'rak_payment_intent_read' permission would allow this request to continue." }));
      await expect(billing.businessOfPackPayment!("pi_pack")).resolves.toBeNull();
      expect(vi.mocked(reportWarning).mock.calls.map(([error, properties]) => [(error as Error).message, properties])).toEqual([[expect.stringContaining("read access to PaymentIntents"), { operation: "billing.webhook", paymentIntent: "pi_pack" }]]);
      // A rate limit, a lost connection or Stripe's own error may pass when Stripe sends the event again.
      for (const error of [
        new Stripe.errors.StripeRateLimitError({ type: "rate_limit_error", message: "Too many requests." }),
        new Stripe.errors.StripeConnectionError({ type: "api_error", message: "An error occurred with our connection to Stripe." }),
        new Stripe.errors.StripeAPIError({ type: "api_error", message: "An unknown error occurred." }),
      ]) {
        retrieve.mockRejectedValueOnce(error);
        await expect(billing.businessOfPackPayment!("pi_pack")).rejects.toBe(error);
      }
      expect(reportWarning).toHaveBeenCalledTimes(1);
    });
  });
});
