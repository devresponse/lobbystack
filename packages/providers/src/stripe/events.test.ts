import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { BillingWebhookRefusal } from "../billing/errors";
import type { PriceLinks } from "../billing/types";
import { checkStripeSignature, StripeWebhook, stripeWebhookSecrets, verifyStripeThinEvent } from "./events";

// Stripe's webhook: who may deliver, and each event it uses in reconcile's
// terms, from events shaped as Stripe sends them in the pinned API version.

const now = new Date("2026-11-08T10:00:00.000Z");
const seconds = Math.floor(now.getTime() / 1000);
const businessId = "ed4f1b6f-a237-4c09-8e26-68c3b976b110";
const secret = "whsec_test_current";
const old = "whsec_test_previous";

function sign(body: string, secrets: string[] = [secret], at = seconds): Headers {
  const signatures = secrets.map((key) => `v1=${createHmac("sha256", key).update(`${at}.${body}`).digest("hex")}`);
  return new Headers({ "stripe-signature": [`t=${at}`, ...signatures].join(",") });
}

function event(type: string, object: Record<string, unknown>, fields: Record<string, unknown> = {}) {
  return JSON.stringify({ id: "evt_1Abc", object: "event", type, created: seconds - 5, livemode: false, api_version: "2026-10-28.endive", data: { object }, ...fields });
}

const webhook = (secrets = [secret], env: "sandbox" | "live" = "sandbox") => new StripeWebhook({ secrets, env, now: () => now });

const links: Pick<PriceLinks, "planFor"> = {
  planFor: (ref) => ({ price_pro_month: { plan: "pro", code: "pro", interval: "monthly" as const }, price_starter_month: { plan: "starter", code: "starter", interval: "monthly" as const } })[ref ?? ""] ?? null,
};

const item = (price: string, extra: Record<string, unknown> = {}) => ({ id: `si_${price}`, price: { id: price, recurring: { interval: "month", usage_type: "licensed" }, metadata: {} }, current_period_start: seconds - 86_400, current_period_end: seconds + 29 * 86_400, ...extra });

const subscription = (fields: Record<string, unknown> = {}) => ({
  id: "sub_1",
  object: "subscription",
  customer: "cus_1",
  status: "active",
  items: { data: [item("price_pro_month")] },
  discounts: [],
  schedule: null,
  cancel_at: null,
  cancel_at_period_end: false,
  ended_at: null,
  pending_update: null,
  latest_invoice: "in_1",
  metadata: { lobbystack_business: businessId, lobbystack_checkout: "chk_1" },
  ...fields,
});

function deliver(type: string, object: Record<string, unknown>) {
  const body = event(type, object);
  const delivery = webhook().verify(body, sign(body));
  return webhook().normalize(delivery, links);
}

function refusal(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof BillingWebhookRefusal) return error.reason;
    throw error;
  }
  return "taken";
}

describe("the Stripe webhook's check", () => {
  it("takes an event signed with the endpoint's secret, or either secret during a rotation", () => {
    const body = event("invoice.paid", { id: "in_1" });
    expect(webhook().verify(body, sign(body))).toMatchObject({ id: "evt_1Abc", type: "invoice.paid", livemode: false, object: { id: "in_1" }, createdAt: new Date((seconds - 5) * 1000) });
    // Stripe signs with both of the endpoint's secrets while one rolls over, and either may be the instance's.
    expect(refusal(() => webhook([old]).verify(body, sign(body, [secret, old])))).toBe("taken");
    expect(refusal(() => webhook([secret, old]).verify(body, sign(body, [old])))).toBe("taken");
    expect(stripeWebhookSecrets(" whsec_a , whsec_b ,")).toEqual(["whsec_a", "whsec_b"]);
  });

  it("refuses an unconfigured secret, a missing or bad signature, an old one, the other mode and a body that isn't an event", () => {
    const body = event("invoice.paid", { id: "in_1" });
    expect(refusal(() => webhook([]).verify(body, sign(body)))).toBe("unconfigured");
    expect(refusal(() => webhook().verify(body, new Headers()))).toBe("missing_headers");
    expect(refusal(() => webhook().verify(body, new Headers({ "stripe-signature": "t=1" })))).toBe("missing_headers");
    expect(refusal(() => webhook().verify(body, sign(body, ["whsec_someone_else"])))).toBe("bad_signature");
    expect(refusal(() => webhook().verify(`${body} `, sign(body)))).toBe("bad_signature");
    expect(refusal(() => webhook().verify(body, sign(body, [secret], seconds - 301)))).toBe("too_old");
    expect(refusal(() => webhook([secret], "live").verify(body, sign(body)))).toBe("wrong_mode");
    const notAnEvent = JSON.stringify({ hello: "world" });
    expect(refusal(() => webhook().verify(notAnEvent, sign(notAnEvent)))).toBe("invalid_payload");
    expect(checkStripeSignature(body, sign(body).get("stripe-signature"), [secret], now)).toBe("ok");
  });

  it("checks the meter error destination's thin events with its own secret", () => {
    const thin = JSON.stringify({ id: "evt_thin_1", object: "v2.core.event", type: "v1.billing.meter.no_meter_found", created: now.toISOString(), livemode: false, related_object: { id: "mtr_1", type: "billing.meter", url: "/v1/billing/meters/mtr_1" } });
    expect(verifyStripeThinEvent(thin, sign(thin, ["whsec_meter"]), { secrets: ["whsec_meter"], env: "sandbox", now })).toMatchObject({ type: "v1.billing.meter.no_meter_found", related_object: { id: "mtr_1" } });
    expect(refusal(() => verifyStripeThinEvent(thin, sign(thin, [secret]), { secrets: ["whsec_meter"], env: "sandbox", now }))).toBe("bad_signature");
    expect(refusal(() => verifyStripeThinEvent(thin, sign(thin, ["whsec_meter"]), { secrets: ["whsec_meter"], env: "live", now }))).toBe("wrong_mode");
  });
});

describe("Stripe's events in reconcile's terms", () => {
  it("reads a subscription's plan item, status, period and end, under the names reconcile reads", () => {
    const normalized = deliver("customer.subscription.updated", subscription({ cancel_at_period_end: true, items: { data: [item("price_overage_voice", { price: { id: "price_overage_voice", recurring: { interval: "month", usage_type: "metered" }, metadata: {} } }), item("price_pro_month")] } }));
    const periodEnd = new Date((seconds + 29 * 86_400) * 1000).toISOString();
    expect(normalized).toMatchObject({
      kind: "subscription",
      businessId,
      fields: { customerId: "cus_1", subscriptionId: "sub_1", priceRef: "price_pro_month", plan: "pro", planCode: "pro", billingInterval: "monthly", subscriptionState: "active", periodEnd, cancelAt: periodEnd, nextChange: null, subscriptionModifiedAt: new Date((seconds - 5) * 1000).toISOString() },
      payload: { id: "sub_1", kind: "subscription", subscriptionId: "sub_1", customerId: "cus_1", priceRef: "price_pro_month", plan: "pro", subscriptionState: "active", currentPeriodEnd: periodEnd, cancelAt: periodEnd, nextChange: null, metadata: { lobbystack_checkout: "chk_1" } },
    });
    // A schedule that isn't expanded leaves the waiting change to the read-back.
    expect(deliver("customer.subscription.updated", subscription({ schedule: "sub_sched_1" }))!.fields).not.toHaveProperty("nextChange");
    // A price the catalog doesn't link names no plan.
    expect(deliver("customer.subscription.created", subscription({ items: { data: [item("price_unknown")] } }))!.fields).toMatchObject({ priceRef: "price_unknown" });
    expect(deliver("customer.subscription.created", subscription({ items: { data: [item("price_unknown")] } }))!.fields).not.toHaveProperty("plan");
  });

  it("keeps the overage subscription's events away from the plan", () => {
    const normalized = deliver("customer.subscription.updated", subscription({ id: "sub_overage", metadata: { lobbystack_business: businessId, lobbystack_role: "overage" } }));
    expect(normalized).toMatchObject({ kind: "other", businessId, fields: { customerId: "cus_1" }, payload: { kind: "other", overageSubscriptionId: "sub_overage" } });
    expect(normalized!.payload).not.toHaveProperty("subscriptionId");
  });

  it("reads an invoice as an order: open is pending, and only the plan's invoices name its subscription", () => {
    const invoice = (fields: Record<string, unknown> = {}) => ({ id: "in_1", object: "invoice", customer: "cus_1", status: "paid", total: 8700, currency: "cad", number: "LS-0001", hosted_invoice_url: "https://invoice.stripe.com/i/acct_1/in_1", created: seconds - 60, status_transitions: { paid_at: seconds - 30 }, parent: { type: "subscription_details", subscription_details: { subscription: "sub_1", metadata: { lobbystack_business: businessId } } }, ...fields });
    expect(deliver("invoice.paid", invoice())).toMatchObject({
      kind: "payment",
      businessId,
      fields: { customerId: "cus_1", subscriptionId: "sub_1", payment: { id: "in_1", status: "paid", amountCents: 8700, refundedCents: 0, currency: "cad", invoiceUrl: "https://invoice.stripe.com/i/acct_1/in_1", subscriptionId: "sub_1", description: "Invoice LS-0001", occurredAt: new Date((seconds - 30) * 1000).toISOString() } },
      payload: { id: "in_1", kind: "payment", orderId: "in_1", status: "paid", amountCents: 8700, currency: "cad", subscriptionId: "sub_1", invoiceUrl: "https://invoice.stripe.com/i/acct_1/in_1", description: "Invoice LS-0001" },
    });
    expect(deliver("invoice.payment_failed", invoice({ status: "open", status_transitions: { paid_at: null } }))!.payload).toMatchObject({ status: "pending", occurredAt: new Date((seconds - 60) * 1000).toISOString() });
    const overage = deliver("invoice.paid", invoice({ id: "in_2", parent: { type: "subscription_details", subscription_details: { subscription: "sub_overage", metadata: { lobbystack_business: businessId, lobbystack_role: "overage" } } } }));
    expect(overage).toMatchObject({ kind: "payment", businessId, payload: { orderId: "in_2" } });
    expect(overage!.payload).not.toHaveProperty("subscriptionId");
  });

  it("reads a checkout session's request and outcome, a refund's payment and a dispute", () => {
    expect(deliver("checkout.session.completed", { id: "cs_1", object: "checkout.session", customer: "cus_1", subscription: "sub_1", client_reference_id: "chk_1", metadata: { lobbystack_business: businessId } })).toMatchObject({ kind: "checkout", businessId, fields: { customerId: "cus_1", checkoutRequestId: "chk_1", checkoutOutcome: "completed" } });
    expect(deliver("checkout.session.expired", { id: "cs_1", object: "checkout.session", customer: null, client_reference_id: "chk_1", metadata: { lobbystack_business: businessId } })!.fields).toEqual({ checkoutRequestId: "chk_1", checkoutOutcome: "expired" });
    // A charge names its customer only: the route reads the customer back for the business.
    expect(deliver("charge.refunded", { id: "ch_1", object: "charge", customer: "cus_1", payment_intent: "pi_1", amount: 8700, amount_refunded: 2000, currency: "cad", refunded: false, created: seconds - 10, metadata: {} })).toMatchObject({ kind: "refund", businessId: null, fields: { customerId: "cus_1", payment: { id: "pi_1", status: "partially_refunded", amountCents: 8700, refundedCents: 2000 } }, payload: { paymentRef: "pi_1", refundedAmount: 2000, status: "partially_refunded" } });
    expect(deliver("charge.dispute.created", { id: "dp_1", object: "dispute", charge: "ch_1", amount: 8700, currency: "cad", metadata: {} })).toMatchObject({ kind: "dispute", businessId: null, businessReference: "ch_1" });
  });

  it("drops an event LobbyStack doesn't use", () => {
    expect(deliver("customer.updated", { id: "cus_1", object: "customer" })).toBeNull();
  });
});
