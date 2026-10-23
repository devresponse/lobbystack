import { polarProductLinks, type PolarProductLinks } from "@lobbystack/domain";
import { isUuid } from "@lobbystack/shared";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Translate signed Polar subscription/order payloads into our billing vocabulary.
 * The product names the plan through the billing catalog's links, or without
 * them through the four product variables.
 */
export function normalizePolarEvent(type: string, data: RecordValue, links: Pick<PolarProductLinks, "planFor"> = polarProductLinks({ plans: [], prices: [] }, process.env)) {
  const customer = record(data.customer);
  const customerMetadata = record(customer.metadata);
  const subscription = type.startsWith("subscription.") ? data : record(data.subscription);
  const externalId = text(customer.external_id) ?? text(data.external_customer_id) ?? text(data.externalCustomerId);
  // A Polar customer that predates the Postgres migration still carries the old
  // Convex id in `external_id`, while its metadata holds the current one. Take
  // whichever reference actually identifies a business rather than trusting
  // the first field that happens to be populated.
  const references = [
    text(data.businessId),
    text(customer.external_id),
    text(data.external_customer_id),
    text(data.externalCustomerId),
    text(customerMetadata.externalCustomerId),
    text(customerMetadata.businessId),
  ].flatMap(value => {
    if (!value) return [];
    return [value.match(/^business:(.+)$/)?.[1] ?? value];
  });
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
  return {
    businessId,
    businessReference: candidate,
    payload: {
      ...data,
      ...(externalId ? { billingKey: externalId } : {}),
      ...(customerId ? { customerId } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
      ...(match ? { plan: match.plan, planCode: match.code, billingInterval: match.interval } : {}),
      ...(subscriptionState ? { subscriptionState } : {}),
      ...(discountId ? { discountId } : {}),
      ...(subscriptionModifiedAt ? { subscriptionModifiedAt } : {}),
    },
  };
}
