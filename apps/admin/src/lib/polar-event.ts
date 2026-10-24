import { polarProductLinks, type PolarProductLinks } from "@lobbystack/domain";
import { isUuid } from "@lobbystack/shared";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
/** The business IDs some fields name, as an ID or a `business:<id>` billing key. */
const businessReferences = (values: Array<string | undefined>): string[] => values.flatMap(value => value ? [value.match(/^business:(.+)$/)?.[1] ?? value] : []);

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
  return {
    businessId,
    businessReference: candidate,
    /** The business the customer names, when the checkout's metadata names another. */
    ...(checkoutBusinessId && customerBusinessId && customerBusinessId !== checkoutBusinessId ? { customerBusinessId } : {}),
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
    },
  };
}
