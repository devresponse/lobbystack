import { isUuid } from "@lobbystack/shared";
import { BillingWebhookRefusal } from "../billing/errors";
import type { BillingEventKind, BillingWebhook, NormalizedBillingEvent, PriceLinks, VerifiedDelivery } from "../billing/types";
import { verifyPolarWebhookSignature } from "./webhook";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
/** The business IDs some fields name, as an ID or a `business:<id>` billing key. */
const businessReferences = (values: Array<string | undefined>): string[] => values.flatMap(value => value ? [value.match(/^business:(.+)$/)?.[1] ?? value] : []);

/** What a Polar event is about, from its name: reconcile's own reading of event names before the stored kind. */
export function polarEventKind(type: string): BillingEventKind {
  if (type.startsWith("subscription.")) return "subscription";
  if (type.startsWith("order.")) return "payment";
  if (type.startsWith("refund.")) return "refund";
  if (type.startsWith("checkout.")) return "checkout";
  return "other";
}

/** Polar's webhook: its Standard Webhooks signature with POLAR_WEBHOOK_SECRET, and its events in LobbyStack's terms. */
/** A time Polar sent, as an ISO string; null when it's missing or not a time. */
function isoTime(value: string | undefined): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.valueOf()) ? null : at.toISOString();
}

export class PolarWebhook implements BillingWebhook {
  readonly provider = "polar" as const;

  constructor(private readonly secret: string | undefined) {}

  /** A signature older than five minutes doesn't match either. */
  verify(rawBody: string, headers: Headers): VerifiedDelivery {
    if (!this.secret) throw new BillingWebhookRefusal("polar", "unconfigured");
    const id = headers.get("webhook-id");
    const timestamp = headers.get("webhook-timestamp");
    const signature = headers.get("webhook-signature");
    if (!id || !timestamp || !signature) throw new BillingWebhookRefusal("polar", "missing_headers");
    if (!verifyPolarWebhookSignature(rawBody, { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature }, this.secret)) throw new BillingWebhookRefusal("polar", "bad_signature");
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      throw new BillingWebhookRefusal("polar", "invalid_payload");
    }
    const body = record(raw);
    const type = text(body.type);
    const sentAt = body.timestamp === undefined ? undefined : text(body.timestamp);
    if (raw !== body || !type || !body.data || typeof body.data !== "object" || Array.isArray(body.data) || (body.timestamp !== undefined && (!sentAt || Number.isNaN(Date.parse(sentAt))))) throw new BillingWebhookRefusal("polar", "invalid_payload");
    // Standard Webhooks supplies the delivery ID in headers, not the JSON body.
    return { id, type, createdAt: sentAt ? new Date(sentAt) : new Date(), livemode: null, object: body.data as RecordValue };
  }

  /**
   * Polar's subscription and order payloads in LobbyStack's billing terms. The
   * product names the plan through the billing catalog's links, or without
   * them through the four product variables. Every event is kept: reconcile
   * reads what it can from each.
   */
  normalize(delivery: VerifiedDelivery, links: Pick<PriceLinks, "planFor">): NormalizedBillingEvent {
    const { type } = delivery;
    const data = delivery.object;
    const customer = record(data.customer);
    const customerMetadata = record(customer.metadata);
    const subscription = type.startsWith("subscription.") ? data : record(data.subscription);
    const externalId = text(customer.external_id) ?? text(data.external_customer_id) ?? text(data.externalCustomerId);
    // The worker names the business in each checkout's metadata, which Polar
    // copies onto the subscription and its orders. A subscription belongs to the
    // business that bought it, even on a customer Polar matched by email.
    const checkoutBusinessId = [text(record(data.metadata).lobbystack_business), text(record(subscription.metadata).lobbystack_business)].find(isUuid);
    // A Polar customer that predates the Postgres migration still carries the old
    // Convex id in `external_id`, while its metadata holds the current one. Take
    // whichever reference actually identifies a business rather than trusting
    // the first field that happens to be populated.
    const customerReferences = businessReferences([
      text(customer.external_id),
      text(data.external_customer_id),
      text(data.externalCustomerId),
      text(customerMetadata.externalCustomerId),
      text(customerMetadata.businessId),
    ]);
    const customerBusinessId = customerReferences.find(isUuid);
    const references = [...businessReferences([text(data.businessId)]), ...(checkoutBusinessId ? [checkoutBusinessId] : []), ...customerReferences];
    const businessId = references.find(isUuid);
    const candidate = businessId ?? references[0];
    const productId = text(subscription.product_id) ?? text(data.product_id);
    const match = links.planFor(productId);
    const subscriptionId = text(subscription.id) ?? text(data.subscription_id);
    const customerId = text(customer.id) ?? text(data.customer_id);
    const subscriptionState = text(subscription.status);
    // A promo plan's discount on a standard product, as a switch in Polar's billing portal leaves it, is removed.
    const discountId = text(subscription.discount_id);
    // Reconcile orders subscription snapshots by this, so a late retry cannot roll state back.
    const modifiedAt = new Date(text(subscription.modified_at) ?? text(subscription.created_at) ?? Number.NaN);
    const subscriptionModifiedAt = Number.isNaN(modifiedAt.valueOf()) ? undefined : modifiedAt.toISOString();
    const kind = polarEventKind(type);
    // A subscription event says when the plan ends unless resumed, and a change waiting for the renewal, which
    // Polar applies at the period's end: null when there's none. Other events say nothing, so reconcile leaves them.
    const periodEnd = isoTime(text(subscription.current_period_end));
    const pending = links.planFor(text(record(subscription.pending_update).product_id));
    const cancelAt = kind === "subscription" ? (subscription.cancel_at_period_end === true ? periodEnd : null) : undefined;
    const nextChange = kind === "subscription" ? (pending && periodEnd ? { planCode: pending.code, billingInterval: pending.interval, at: periodEnd } : null) : undefined;
    return {
      kind,
      businessId: businessId ?? null,
      businessReference: candidate ?? null,
      // The business the customer names, when the checkout's metadata names another.
      customerBusinessId: checkoutBusinessId && customerBusinessId && customerBusinessId !== checkoutBusinessId ? customerBusinessId : null,
      fields: {
        ...(externalId ? { billingKey: externalId } : {}),
        ...(customerId ? { customerId } : {}),
        ...(subscriptionId ? { subscriptionId } : {}),
        ...(productId ? { priceRef: productId } : {}),
        ...(match ? { plan: match.plan, planCode: match.code, billingInterval: match.interval } : {}),
        ...(subscriptionState ? { subscriptionState } : {}),
        ...(discountId ? { discountRef: discountId } : {}),
        ...(subscriptionModifiedAt ? { subscriptionModifiedAt } : {}),
        ...(cancelAt !== undefined ? { cancelAt } : {}),
        ...(nextChange !== undefined ? { nextChange } : {}),
      },
      // Today's fields under their Polar names, which a reconcile of the release before reads, then kind and priceRef.
      payload: {
        ...data,
        ...(externalId ? { billingKey: externalId } : {}),
        ...(customerId ? { customerId } : {}),
        ...(subscriptionId ? { subscriptionId } : {}),
        // Reconcile maps a product the catalog links later, while the event waits.
        ...(productId ? { productId } : {}),
        ...(match ? { plan: match.plan, planCode: match.code, billingInterval: match.interval } : {}),
        ...(subscriptionState ? { subscriptionState } : {}),
        ...(discountId ? { discountId } : {}),
        ...(subscriptionModifiedAt ? { subscriptionModifiedAt } : {}),
        ...(cancelAt !== undefined ? { cancelAt } : {}),
        ...(nextChange !== undefined ? { nextChange } : {}),
        kind,
        ...(productId ? { priceRef: productId } : {}),
      },
    };
  }
}
