import { describe, expect, it } from "vitest";

import { PolarBilling } from "../../polar/adapter";
import { PolarRequestError } from "../../polar/polarBilling";
import { stripeHarness } from "./harness";
import { BillingProviderError } from "../errors";

const polar = new PolarBilling({ recordUsage: async () => undefined }, { organizationId: "org-1", env: "sandbox" });

describe("the billing provider contract: refusals", () => {
  describe("on Polar", () => {
    it.each([
      [new PolarRequestError(401, null), "token_scope"],
      [new PolarRequestError(403, "insufficient_scope"), "token_scope"],
      [new PolarRequestError(401, "invalid_token"), "token_scope"],
      [new PolarRequestError(402, null), "payment_failed"],
      [new PolarRequestError(403, "AlreadyCanceledSubscription"), "subscription_ending"],
      [new PolarRequestError(403, null), "subscription_unavailable"],
      [new PolarRequestError(404, null), "subscription_unavailable"],
      [new PolarRequestError(409, null), "change_pending"],
      [new PolarRequestError(422, null), "product_unavailable"],
      [new PolarRequestError(422, "PolarRequestValidationError", ["email"]), "billing_email_taken"],
      [new PolarRequestError(422, "RequestValidationError", ["email"]), "billing_email_invalid"],
      [new PolarRequestError(500, null), undefined],
      [new Error("socket hang up"), undefined],
      [new BillingProviderError("polar", "refused", "refused", "token_scope"), "token_scope"],
    ] as const)("answers %s with %s", (error, refusal) => {
      expect(polar.refusalFor(error)).toBe(refusal);
    });
  });

  describe("on Stripe", () => {
    it("answers Stripe's errors through its error table, and a neutral refusal as itself", () => {
      const { billing } = stripeHarness();
      expect(billing.refusalFor(new BillingProviderError("stripe", "refused", "refused", "change_pending"))).toBe("change_pending");
      expect(billing.refusalFor(new Error("socket hang up"))).toBeUndefined();
    });
  });
});
