import { createHmac, timingSafeEqual } from "node:crypto";

import type Stripe from "stripe";

import { stripeEventSchema, stripeThinEventSchema, type StripeThinEvent } from "@lobbystack/contracts";
import { isUuid, STRIPE_WEBHOOK_EVENTS } from "@lobbystack/shared";

import { BillingWebhookRefusal } from "../billing/errors";
import type { BillingEnv, BillingWebhook, NormalizedBillingEvent, PriceLinks, VerifiedDelivery } from "../billing/types";
import { providerSubscriptionFromStripe } from "./subscriptions";

// Stripe's webhook (the Stripe plan's step 12): the Stripe-Signature header
// checked with one secret, or two during a rotation, the event's mode against
// the deployment's, the events LobbyStack uses, and each in reconcile's terms.
// The business comes from the metadata LobbyStack puts on the subscription
// at checkout, which Stripe copies onto its invoices, or the checkout's own;
// a charge names only its customer, whom the webhook route reads back.

/** How far a signature's time may be from now, as Stripe's own libraries allow. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => (value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {});
const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const idOf = (value: unknown): string | undefined => text(value) ?? text(record(value).id);
const amount = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) ? value : undefined);
const iso = (seconds: unknown): string | undefined => (typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : undefined);
const isoDate = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);

/** The secrets of STRIPE_WEBHOOK_SECRET: one, or during a rotation two, comma-separated. */
export function stripeWebhookSecrets(value: string | undefined): string[] {
  return (value ?? "").split(",").map((secret) => secret.trim()).filter(Boolean);
}

/**
 * Checks Stripe's signature on a delivery: a v1 HMAC-SHA256 of "t.body" with
 * any of the secrets, made within the tolerance of now. Stripe sends a v1
 * signature for each of the endpoint's secrets during a rotation.
 */
export function checkStripeSignature(rawBody: string, header: string | null, secrets: readonly string[], now: Date): "ok" | "missing_headers" | "bad_signature" | "too_old" {
  if (!header) return "missing_headers";
  const parts = header.split(",").map((part) => part.trim().split("="));
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  const signatures = parts.filter(([key, value]) => key === "v1" && value).map(([, value]) => value!);
  if (!Number.isInteger(timestamp) || !signatures.length) return "missing_headers";
  const matches = secrets.some((secret) => {
    const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"));
    return signatures.some((signature) => {
      const given = Buffer.from(signature);
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
  });
  if (!matches) return "bad_signature";
  return Math.abs(now.getTime() / 1000 - timestamp) > STRIPE_SIGNATURE_TOLERANCE_SECONDS ? "too_old" : "ok";
}

/** An invoice's status as an order row keeps it: open waits for its payment, so it's pending. */
function orderStatusOf(status: string | undefined): string {
  return status === "open" ? "pending" : status ?? "received";
}

/** The business a hint names, when it's a business ID. */
const businessOf = (...hints: unknown[]): string | undefined => hints.map(text).find(isUuid);

export class StripeWebhook implements BillingWebhook {
  readonly provider = "stripe" as const;

  /** secrets: STRIPE_WEBHOOK_SECRET's; env: the mode of the deployment's STRIPE_API_KEY. */
  constructor(private readonly options: { secrets: readonly string[]; env: BillingEnv; now?: () => Date }) {}

  /** Throws BillingWebhookRefusal for a delivery that isn't Stripe's, isn't this deployment's mode or isn't an event. */
  verify(rawBody: string, headers: Headers): VerifiedDelivery {
    if (!this.options.secrets.length) throw new BillingWebhookRefusal("stripe", "unconfigured");
    const signature = checkStripeSignature(rawBody, headers.get("stripe-signature"), this.options.secrets, this.options.now?.() ?? new Date());
    if (signature !== "ok") throw new BillingWebhookRefusal("stripe", signature);
    let parsed: ReturnType<typeof stripeEventSchema.safeParse>;
    try {
      parsed = stripeEventSchema.safeParse(JSON.parse(rawBody));
    } catch {
      throw new BillingWebhookRefusal("stripe", "invalid_payload");
    }
    if (!parsed.success) throw new BillingWebhookRefusal("stripe", "invalid_payload");
    const event = parsed.data;
    // A test event on a live deployment, or the reverse, is another deployment's.
    if (event.livemode !== (this.options.env === "live")) throw new BillingWebhookRefusal("stripe", "wrong_mode");
    return { id: event.id, type: event.type, createdAt: new Date(event.created * 1000), livemode: event.livemode, object: event.data.object };
  }

  /** The events LobbyStack uses in reconcile's terms; null for any other, which is answered 202 and not stored. */
  normalize(delivery: VerifiedDelivery, links: Pick<PriceLinks, "planFor">): NormalizedBillingEvent | null {
    if (!(STRIPE_WEBHOOK_EVENTS as readonly string[]).includes(delivery.type)) return null;
    const object = delivery.object;
    if (delivery.type.startsWith("customer.subscription.")) return subscriptionEvent(delivery, links);
    if (delivery.type.startsWith("invoice.")) return invoiceEvent(object);
    if (delivery.type.startsWith("checkout.session.")) return checkoutEvent(delivery);
    if (delivery.type === "charge.refunded") return refundEvent(object);
    return disputeEvent(object);
  }
}

/**
 * A subscription event: the plan's item and its price, the subscription's own
 * status, the period, and when it ends or changes. The overage subscription
 * moves no plan, so its events are about the customer only.
 */
function subscriptionEvent(delivery: VerifiedDelivery, links: Pick<PriceLinks, "planFor">): NormalizedBillingEvent {
  const object = delivery.object;
  const metadata = record(object.metadata);
  const businessId = businessOf(metadata.lobbystack_business);
  const customerId = idOf(object.customer);
  const subscriptionId = idOf(object.id);
  const base = { businessId: businessId ?? null, businessReference: businessId ?? text(metadata.lobbystack_business) ?? null, customerBusinessId: null };
  if (metadata.lobbystack_role === "overage") {
    return { kind: "other", ...base, fields: { ...(customerId ? { customerId } : {}) }, payload: { ...object, kind: "other", ...(customerId ? { customerId } : {}), ...(subscriptionId ? { overageSubscriptionId: subscriptionId } : {}) } };
  }
  const read = providerSubscriptionFromStripe(object as unknown as Stripe.Subscription, delivery.createdAt);
  const match = links.planFor(read.priceRef);
  const subscriptionState = text(object.status);
  // The read time orders snapshots, so a late retry never rolls the account back.
  const subscriptionModifiedAt = delivery.createdAt.toISOString();
  const periodStart = isoDate(read.periodStart);
  const periodEnd = isoDate(read.periodEnd);
  const cancelAt = isoDate(read.cancelAt);
  // An event's schedule is an ID: the read-back knows its next phase. Without a schedule nothing is waiting.
  const nextMatch = read.next ? links.planFor(read.next.priceRef) : null;
  const nextChange = read.next && nextMatch ? { planCode: nextMatch.code, billingInterval: nextMatch.interval, at: read.next.at.toISOString() } : object.schedule ? undefined : null;
  const fields: NormalizedBillingEvent["fields"] = {
    ...(customerId ? { customerId } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
    ...(read.priceRef ? { priceRef: read.priceRef } : {}),
    ...(match ? { plan: match.plan, planCode: match.code, billingInterval: match.interval } : {}),
    ...(subscriptionState ? { subscriptionState } : {}),
    ...(read.discountRef ? { discountRef: read.discountRef } : {}),
    subscriptionModifiedAt,
    ...(periodStart ? { periodStart } : {}),
    ...(periodEnd ? { periodEnd } : {}),
    cancelAt,
    ...(nextChange !== undefined ? { nextChange } : {}),
  };
  return {
    kind: "subscription",
    ...base,
    fields,
    // Under the names reconcile reads, beside Stripe's own.
    payload: {
      ...object,
      kind: "subscription",
      ...(customerId ? { customerId } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
      ...(read.priceRef ? { priceRef: read.priceRef } : {}),
      ...(match ? { plan: match.plan, planCode: match.code, billingInterval: match.interval } : {}),
      ...(subscriptionState ? { subscriptionState } : {}),
      ...(read.discountRef ? { discountId: read.discountRef } : {}),
      subscriptionModifiedAt,
      ...(periodStart ? { currentPeriodStart: periodStart } : {}),
      ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
      cancelAt,
      ...(nextChange !== undefined ? { nextChange } : {}),
    },
  };
}

/**
 * An invoice event: a payment, stored as an order row. An open invoice waits
 * for its payment. Only the plan subscription's invoices name a subscription:
 * the overage subscription's are payments of the business all the same.
 */
function invoiceEvent(object: RecordValue): NormalizedBillingEvent {
  const details = record(record(object.parent).subscription_details);
  const subscriptionMetadata = record(details.metadata);
  const businessId = businessOf(subscriptionMetadata.lobbystack_business, record(object.metadata).lobbystack_business);
  const customerId = idOf(object.customer);
  const overage = subscriptionMetadata.lobbystack_role === "overage";
  const subscriptionId = overage ? undefined : idOf(details.subscription);
  const id = idOf(object.id) ?? "";
  const status = orderStatusOf(text(object.status));
  const amountCents = amount(object.total) ?? 0;
  const currency = text(object.currency) ?? "";
  const invoiceUrl = text(object.hosted_invoice_url) ?? null;
  const number = text(object.number);
  const description = number ? `Invoice ${number}` : null;
  const occurredAt = iso(record(object.status_transitions).paid_at) ?? iso(object.created) ?? new Date().toISOString();
  return {
    kind: "payment",
    businessId: businessId ?? null,
    businessReference: businessId ?? null,
    customerBusinessId: null,
    fields: {
      ...(customerId ? { customerId } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
      payment: { id, status, amountCents, refundedCents: 0, currency, invoiceUrl, subscriptionId: subscriptionId ?? null, description, occurredAt },
    },
    payload: {
      ...object,
      kind: "payment",
      ...(customerId ? { customerId } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
      orderId: id,
      status,
      amountCents,
      currency,
      occurredAt,
      ...(invoiceUrl ? { invoiceUrl } : {}),
      ...(description ? { description } : {}),
    },
  };
}

/** A checkout session that completed or expired: the checkout request it was for. */
function checkoutEvent(delivery: VerifiedDelivery): NormalizedBillingEvent {
  const object = delivery.object;
  const metadata = record(object.metadata);
  const businessId = businessOf(metadata.lobbystack_business);
  const customerId = idOf(object.customer);
  const checkoutRequestId = text(object.client_reference_id) ?? text(metadata.lobbystack_checkout);
  const checkoutOutcome = delivery.type === "checkout.session.completed" ? "completed" as const : "expired" as const;
  return {
    kind: "checkout",
    businessId: businessId ?? null,
    businessReference: businessId ?? null,
    customerBusinessId: null,
    fields: { ...(customerId ? { customerId } : {}), ...(checkoutRequestId ? { checkoutRequestId } : {}), checkoutOutcome },
    // The subscription's own events move the plan, so a checkout names none here.
    payload: { ...object, kind: "checkout", ...(customerId ? { customerId } : {}), ...(checkoutRequestId ? { checkoutRequestId } : {}), checkoutOutcome },
  };
}

/** A charge refunded, in part or in full: the payment it refunds, which the worker reads back to its invoice. */
function refundEvent(object: RecordValue): NormalizedBillingEvent {
  const businessId = businessOf(record(object.metadata).lobbystack_business);
  const customerId = idOf(object.customer);
  const paymentRef = idOf(object.payment_intent) ?? idOf(object.id) ?? "";
  const amountCents = amount(object.amount) ?? 0;
  const refundedCents = amount(object.amount_refunded) ?? 0;
  const currency = text(object.currency) ?? "";
  const status = object.refunded === true || refundedCents >= amountCents ? "refunded" : "partially_refunded";
  const occurredAt = iso(object.created) ?? new Date().toISOString();
  return {
    kind: "refund",
    businessId: businessId ?? null,
    businessReference: businessId ?? null,
    customerBusinessId: null,
    fields: { ...(customerId ? { customerId } : {}), payment: { id: paymentRef, status, amountCents, refundedCents, currency, invoiceUrl: null, subscriptionId: null, description: null, occurredAt } },
    payload: { ...object, kind: "refund", ...(customerId ? { customerId } : {}), paymentRef, refundedAmount: refundedCents, status, occurredAt },
  };
}

/** A dispute opened on a charge. It names no customer, so unless its metadata names the business it's logged and dropped. */
function disputeEvent(object: RecordValue): NormalizedBillingEvent {
  const businessId = businessOf(record(object.metadata).lobbystack_business);
  return { kind: "dispute", businessId: businessId ?? null, businessReference: businessId ?? idOf(object.charge) ?? null, customerBusinessId: null, fields: {}, payload: { ...object, kind: "dispute" } };
}

/**
 * A delivery to the meter error destination: Stripe's thin event, signed with
 * STRIPE_METER_WEBHOOK_SECRET, of this deployment's mode. Throws
 * BillingWebhookRefusal as StripeWebhook.verify does.
 */
export function verifyStripeThinEvent(rawBody: string, headers: Headers, options: { secrets: readonly string[]; env: BillingEnv; now?: Date }): StripeThinEvent {
  if (!options.secrets.length) throw new BillingWebhookRefusal("stripe", "unconfigured");
  const signature = checkStripeSignature(rawBody, headers.get("stripe-signature"), options.secrets, options.now ?? new Date());
  if (signature !== "ok") throw new BillingWebhookRefusal("stripe", signature);
  let parsed: ReturnType<typeof stripeThinEventSchema.safeParse>;
  try {
    parsed = stripeThinEventSchema.safeParse(JSON.parse(rawBody));
  } catch {
    throw new BillingWebhookRefusal("stripe", "invalid_payload");
  }
  if (!parsed.success) throw new BillingWebhookRefusal("stripe", "invalid_payload");
  if (parsed.data.livemode !== (options.env === "live")) throw new BillingWebhookRefusal("stripe", "wrong_mode");
  return parsed.data;
}
