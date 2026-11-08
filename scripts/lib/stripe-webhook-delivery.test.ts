import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { StripeWebhook } from "../../packages/providers/src/stripe/events";
import { certificationInvoicePaid, stripeSignatureHeader } from "./stripe-webhook-delivery";

// The webhook certification's Stripe delivery must pass the admin's own check:
// the signature, the mode, the event's shape, and a business to store it for.

const noLinks = { planFor: () => null };

function headers(body: string, secret: string, at?: Date): Headers {
  return new Headers({ "content-type": "application/json", "stripe-signature": stripeSignatureHeader(body, secret, at) });
}

describe("the webhook certification's Stripe delivery", () => {
  it("is a paid invoice of the business, signed as Stripe signs it", () => {
    const businessId = randomUUID();
    const { eventId, body } = certificationInvoicePaid({ businessId, suffix: randomUUID(), livemode: false });
    const webhook = new StripeWebhook({ secrets: ["whsec_certification"], env: "sandbox" });
    const delivery = webhook.verify(body, headers(body, "whsec_certification"));
    expect(delivery).toMatchObject({ id: eventId, type: "invoice.paid", livemode: false });
    expect(webhook.normalize(delivery, noLinks)).toMatchObject({ kind: "payment", businessId, fields: { payment: { status: "paid", amountCents: 0 } } });
  });

  it("is refused with another secret, an old signature or the other mode", () => {
    const { body } = certificationInvoicePaid({ businessId: randomUUID(), suffix: randomUUID(), livemode: false });
    const sandbox = new StripeWebhook({ secrets: ["whsec_certification"], env: "sandbox" });
    expect(() => sandbox.verify(body, headers(body, "whsec_other"))).toThrow(expect.objectContaining({ reason: "bad_signature" }));
    expect(() => sandbox.verify(body, headers(body, "whsec_certification", new Date(Date.now() - 10 * 60_000)))).toThrow(expect.objectContaining({ reason: "too_old" }));
    const live = new StripeWebhook({ secrets: ["whsec_certification"], env: "live" });
    expect(() => live.verify(body, headers(body, "whsec_certification"))).toThrow(expect.objectContaining({ reason: "wrong_mode" }));
    const liveBody = certificationInvoicePaid({ businessId: randomUUID(), suffix: randomUUID(), livemode: true }).body;
    expect(live.verify(liveBody, headers(liveBody, "whsec_certification")).livemode).toBe(true);
  });
});
