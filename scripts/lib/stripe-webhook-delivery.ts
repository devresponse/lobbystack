import { createHmac } from "node:crypto";

import { STRIPE_API_VERSION } from "@lobbystack/shared";

// What the webhook certification (scripts/replacement-webhook-check.ts) sends a
// deployment billed through Stripe: an event as Stripe sends it, signed as
// Stripe signs it, so the admin checks it as it checks Stripe's own.

/** The Stripe-Signature header Stripe sends with a body: a v1 HMAC-SHA256 of "t.body" with the endpoint's secret. */
export function stripeSignatureHeader(body: string, secret: string, at: Date = new Date()): string {
  const timestamp = Math.floor(at.getTime() / 1000);
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/**
 * A paid invoice of a business, the event the certification sends: the admin
 * stores it as the business's payment once, and answers a second delivery as a
 * duplicate. It names the business as Stripe's copy of the subscription's
 * metadata does, and no customer, so the admin needs no call to Stripe.
 */
export function certificationInvoicePaid(input: { businessId: string; suffix: string; livemode: boolean; at?: Date }): { eventId: string; body: string } {
  const id = input.suffix.replace(/[^A-Za-z0-9]/g, "");
  const created = Math.floor((input.at ?? new Date()).getTime() / 1000);
  const eventId = `evt_cert${id}`;
  const body = JSON.stringify({
    id: eventId,
    object: "event",
    api_version: STRIPE_API_VERSION,
    created,
    livemode: input.livemode,
    type: "invoice.paid",
    data: {
      object: {
        id: `in_cert${id}`,
        object: "invoice",
        status: "paid",
        total: 0,
        currency: "usd",
        created,
        status_transitions: { paid_at: created },
        metadata: { lobbystack_business: input.businessId },
      },
    },
  });
  return { eventId, body };
}
