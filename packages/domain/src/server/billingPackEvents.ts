import { and, eq, inArray, min, sql } from "drizzle-orm";

import { billingAccounts, billingPackCheckouts, billingPackPrices, billingTransactions, enqueueOutbox, providerEvents, type DatabaseTransaction } from "@lobbystack/db";
import { isPaidSubscription, isUuid } from "@lobbystack/shared";
import { getPostHogDistinctIdForBusinessSystem } from "@lobbystack/telemetry";
import { logEvent } from "@lobbystack/telemetry/node";

import { recordAffiliateCommissionInTransaction } from "./affiliates";
import { dateField, numberField, recordObject, stringField } from "./billingFields";
import {
  applyPackRefundInTransaction,
  clearPackNumberReleaseInTransaction,
  closePackDisputeInTransaction,
  freezePackInTransaction,
  readLivePacks,
  readPackPlan,
  recordPackPurchaseInTransaction,
  replaceLivePacksInTransaction,
  lockBusinessPacks,
  type PackChange,
  type PackPlanTerms,
} from "./billingPacks";
import { recordProductEventInTransaction } from "./productEvents";
import { enqueueReceptionistAllowanceCheck } from "./receptionists";

// What the billing provider's events do to prepaid packs (docs/features/prepaid-packs.md).
// reconcileBillingProviderEvent calls these in its own transaction, under the
// business's billing lock, after it wrote the account, so they read the account
// as the event found it and every change commits with the event.
//
// - A pack's payment adds the pack once: on Stripe the pack's checkout session,
//   paid at once or once a payment that settles later succeeds, keyed on its
//   PaymentIntent; on Polar the one-time order for a pack's product, keyed on the
//   order. Stripe as merchant of record makes no invoice, so the payment's order
//   row is keyed on the PaymentIntent; Stripe directly invoices the payment, and
//   the invoice's own events make its row as they do for plans.
// - Refunds take their share of the pack off, or end it when the whole payment
//   went back. Stripe names the PaymentIntent; Polar reports an order's refunds
//   on the order. A Stripe dispute freezes the pack until it closes: won, the
//   pack is live again; lost, it ends. Polar has no dispute event.
// - Decision 6, subscription to pack: a payment that finds a live monthly Starter
//   or Pro subscription marks it replaced, which LobbyStack treats as ended from
//   then on, starts the pack's allowances, and queues billing.endPlanForPack to
//   end it at the provider. A yearly or past-due one stays (the checkout refuses
//   both, decisions 6a and 6b), and so does an operator's managed plan; the pack
//   waits beside it and ops.billing.pack_beside_subscription reports it.
// - Decision 6, pack to subscription: a subscription that starts ends the live
//   packs (packsGiveWayToSubscriptionInTransaction) and starts its allowances.
// - Everything here acts on rows that name a pack, so an event about no pack
//   changes nothing, and a business that never bought one sees no change.

/** The account as reconcile read it before the event, which decides what a pack's payment switches from. */
export type PackSwitchAccount = {
  subscriptionId: string | null;
  plan: string | null;
  subscriptionState: string | null;
  billingInterval: string | null;
  /** On an operator's managed plan now. */
  managed: boolean;
  /** The subscription a pack replaced, which the provider may still be ending. */
  replacedSubscriptionId: string | null;
};

/** A stored event, with the parts reconcile already read from it. */
export type PackEventInput = {
  businessId: string;
  provider: string;
  kind: string;
  /** The provider_events row's id. */
  eventId: string;
  eventCreatedAt: Date;
  payload: Record<string, unknown>;
  account: PackSwitchAccount | undefined;
  /** The order row reconcile wrote for a Polar order, and what it read off the order. */
  order?: { transactionId: string; orderId: string; status: string; amountCents: number; refundedCents: number; currency: string; occurredAt: Date; productId: string | undefined; metadata: Record<string, unknown>; checkoutId: string | undefined } | undefined;
};

/** Which pack a payment bought: the catalog's terms now, and the price it was sold at. */
type BoughtPack = { terms: PackPlanTerms; priceId: string | null };

/**
 * Applies what a stored event says about a pack, if anything: a pack checkout's
 * outcome and payment (Stripe), a pack's order (Polar), or a dispute of a
 * pack's payment (Stripe). Refunds go through applyStripePackRefundInTransaction,
 * which the refund step calls. Returns whether the event was about a pack.
 */
export async function applyPackEventInTransaction(tx: DatabaseTransaction, input: PackEventInput): Promise<boolean> {
  if (input.provider === "stripe" && input.kind === "checkout" && stringField(input.payload, "role") === "pack") {
    await applyStripePackCheckout(tx, input);
    return true;
  }
  if (input.provider === "stripe" && input.kind === "dispute") return await applyStripePackDispute(tx, input);
  if (input.provider === "polar" && input.kind === "payment" && input.order) return await applyPolarPackOrder(tx, input, input.order);
  return false;
}

/**
 * A Stripe refund of a pack's payment: refundedCents is the charge's whole
 * refunded amount so far. Null when no pack has the payment, so the refund is
 * about something else; a pack bought later reads it back then.
 */
export async function applyStripePackRefundInTransaction(tx: DatabaseTransaction, input: { businessId: string; paymentRef: string; refundedCents: number; at: Date }): Promise<PackChange | null> {
  const change = await applyPackRefundInTransaction(tx, { businessId: input.businessId, provider: "stripe", providerRef: input.paymentRef, refundedCents: input.refundedCents, at: input.at });
  if (change) await afterPackChange(tx, input.businessId, change);
  return change;
}

/**
 * Decision 6, pack to subscription: a subscription that went live ends the
 * business's live packs, their unused minutes recorded, and the month's
 * allowances count from now. A number set to go once the last pack ended stays.
 * Returns the packs it ended; none for a business without a live pack.
 */
export async function packsGiveWayToSubscriptionInTransaction(tx: DatabaseTransaction, input: { businessId: string; at: Date }): Promise<string[]> {
  const replaced = await replaceLivePacksInTransaction(tx, input);
  await clearPackNumberReleaseInTransaction(tx, input.businessId);
  if (replaced.length) {
    await tx.update(billingAccounts).set({ allowancesSince: input.at, updatedAt: input.at }).where(eq(billingAccounts.businessId, input.businessId));
    for (const packId of replaced) await publishPackUpdate(tx, input.businessId, packId, "replaced");
  }
  return replaced;
}

async function applyStripePackCheckout(tx: DatabaseTransaction, input: PackEventInput): Promise<void> {
  const payload = input.payload;
  const outcome = stringField(payload, "packOutcome");
  const checkoutId = stringField(payload, "packCheckoutId");
  if (outcome === "expired" || outcome === "failed") {
    if (checkoutId) await settlePackCheckout(tx, { businessId: input.businessId, checkoutId, status: outcome });
    return;
  }
  if (outcome !== "paid") return;
  const bought = await packOfStripeCheckout(tx, input.businessId, payload);
  // The payment cleared but names no pack this deployment sells: the event stays received and the sweep reports it.
  if (!bought) throw new Error("The pack's payment names no pack in the catalog.");
  if (checkoutId) await settlePackCheckout(tx, { businessId: input.businessId, checkoutId, status: "paid" });
  const paymentRef = stringField(payload, "paymentRef") ?? stringField(payload, "id");
  if (!paymentRef) throw new Error("The pack's payment names no payment.");
  const amountCents = Math.max(0, Math.round(numberField(payload, "amountCents") ?? 0));
  const currency = (stringField(payload, "currency") ?? "").toLowerCase();
  const paidAt = dateField(payload, "occurredAt") ?? input.eventCreatedAt;
  // Refunds and disputes Stripe sent before this event found no pack; they apply now.
  const history = await stripePaymentHistory(tx, input.businessId, paymentRef);
  const invoiceRef = stringField(payload, "invoiceRef");
  const transactionId = invoiceRef
    ? await orderRowOf(tx, invoiceRef)
    : await recordStripePackOrder(tx, { businessId: input.businessId, paymentRef, amountCents, refundedCents: Math.min(history.refundedCents, amountCents), currency, customerId: stringField(payload, "customerId"), occurredAt: paidAt });
  await recordPurchase(tx, input, { bought, providerRef: paymentRef, amountCents, currency, paidAt, transactionId, boughtAt: checkoutStartedAt(payload) ?? paidAt, history });
}

async function applyPolarPackOrder(tx: DatabaseTransaction, input: PackEventInput, order: NonNullable<PackEventInput["order"]>): Promise<boolean> {
  if (!order.productId || !["paid", "partially_refunded", "refunded"].includes(order.status)) return false;
  const bought = await packOfPrice(tx, order.productId);
  if (!bought) return false;
  const checkoutId = stringField(order.metadata, "lobbystack_pack_checkout") ?? await packCheckoutOf(tx, input.businessId, order.checkoutId);
  if (checkoutId) await settlePackCheckout(tx, { businessId: input.businessId, checkoutId, status: "paid" });
  // The order carries its refunds, so whichever of its events comes first adds the pack and applies them.
  await recordPurchase(tx, input, { bought, providerRef: order.orderId, amountCents: order.amountCents, currency: order.currency, paidAt: order.occurredAt, transactionId: order.transactionId, boughtAt: order.occurredAt, history: { refundedCents: 0, dispute: null } });
  const refund = await applyPackRefundInTransaction(tx, { businessId: input.businessId, provider: "polar", providerRef: order.orderId, refundedCents: order.refundedCents, at: input.eventCreatedAt });
  if (refund) await afterPackChange(tx, input.businessId, refund);
  return true;
}

async function applyStripePackDispute(tx: DatabaseTransaction, input: PackEventInput): Promise<boolean> {
  const paymentRef = stringField(input.payload, "paymentRef");
  if (!paymentRef) return false;
  const change = await applyDispute(tx, input.businessId, paymentRef, stringField(input.payload, "disputeOutcome"), dateField(input.payload, "occurredAt") ?? input.eventCreatedAt);
  if (change) await afterPackChange(tx, input.businessId, change);
  return change !== null;
}

async function applyDispute(tx: DatabaseTransaction, businessId: string, paymentRef: string, outcome: string | undefined, at: Date): Promise<PackChange | null> {
  if (outcome === "opened") return await freezePackInTransaction(tx, { businessId, provider: "stripe", providerRef: paymentRef });
  if (outcome === "won" || outcome === "lost") return await closePackDisputeInTransaction(tx, { businessId, provider: "stripe", providerRef: paymentRef, won: outcome === "won", at });
  return null;
}

type Purchase = {
  bought: BoughtPack;
  providerRef: string;
  amountCents: number;
  currency: string;
  paidAt: Date;
  transactionId: string | null;
  /** When the business started buying it, which orders it against a subscription bought meanwhile. */
  boughtAt: Date;
  history: PaymentHistory;
};

/** Adds the pack once, and on the first delivery switches the business onto it. */
async function recordPurchase(tx: DatabaseTransaction, input: PackEventInput, purchase: Purchase): Promise<void> {
  const provider = input.provider === "polar" ? "polar" : "stripe";
  await lockBusinessPacks(tx, input.businessId);
  const now = new Date();
  const hadLivePacks = (await readLivePacks(tx, input.businessId, { now })).length > 0;
  const recorded = await recordPackPurchaseInTransaction(tx, {
    businessId: input.businessId,
    pack: purchase.bought.terms,
    priceId: purchase.bought.priceId,
    provider,
    providerRef: purchase.providerRef,
    amountCents: purchase.amountCents,
    currency: purchase.currency,
    paidAt: purchase.paidAt,
    transactionId: purchase.transactionId,
  });
  if (!recorded.created) return;
  if (purchase.history.refundedCents > 0) await applyPackRefundInTransaction(tx, { businessId: input.businessId, provider, providerRef: purchase.providerRef, refundedCents: purchase.history.refundedCents, at: now });
  if (purchase.history.dispute) {
    await freezePackInTransaction(tx, { businessId: input.businessId, provider, providerRef: purchase.providerRef });
    if (purchase.history.dispute !== "opened") await applyDispute(tx, input.businessId, purchase.providerRef, purchase.history.dispute, now);
  }
  const switched = await switchToPack(tx, { businessId: input.businessId, packId: recorded.packId, account: input.account, hadLivePacks, boughtAt: purchase.boughtAt, now });
  // The number a business keeps through a pack stays when another pack comes before its release.
  if (switched !== "gave_way") await clearPackNumberReleaseInTransaction(tx, input.businessId);
  // A pack's receptionist allowance can be below the plan it replaces: the newest receptionists past it pause.
  await enqueueReceptionistAllowanceCheck(tx, input.businessId, "billing_pack");
  await publishPackUpdate(tx, input.businessId, recorded.packId, "active");
  await recordProductEventInTransaction(tx, {
    name: "billing.pack_purchased",
    distinctId: getPostHogDistinctIdForBusinessSystem(input.businessId),
    businessId: input.businessId,
    actorType: "worker",
    // The taxonomy requires each, and a null reads as missing, which outside cloud throws and would roll the payment back.
    properties: {
      pack: purchase.bought.terms.code,
      days: purchase.bought.terms.days === null ? "never" : String(purchase.bought.terms.days),
      provider,
      previousPlan: switched === "topped_up" ? "prepaid" : switched === "replaced" || switched === "beside" || switched === "gave_way" ? input.account?.plan ?? "none" : "free_cloud",
    },
  });
}

type Switch = "replaced" | "beside" | "gave_way" | "started" | "topped_up";

/**
 * Decision 6, subscription to pack. replaced: a live monthly subscription now
 * counts as ended and billing.endPlanForPack ends it at the provider. beside: a
 * yearly, past-due or managed plan stays in force, which the checkout refuses,
 * so it is reported. gave_way: the business subscribed after it started buying
 * the pack, so the subscription is its latest choice and the pack ends at once.
 * started: from Free, the pack's allowances count from now. topped_up: another
 * pack was live, so nothing changes.
 */
async function switchToPack(tx: DatabaseTransaction, input: { businessId: string; packId: string; account: PackSwitchAccount | undefined; hadLivePacks: boolean; boughtAt: Date; now: Date }): Promise<Switch> {
  const account = input.account;
  if (account?.managed) {
    logEvent("warn", "ops.billing.pack_beside_subscription", { businessId: input.businessId, packId: input.packId, reason: "managed" });
    return "beside";
  }
  const replacedAlready = Boolean(account?.replacedSubscriptionId) && account?.replacedSubscriptionId === account?.subscriptionId;
  const subscriptionId = account?.subscriptionId ?? null;
  if (account && subscriptionId && !replacedAlready && isPaidSubscription(account.plan, account.subscriptionState)) {
    if (await subscribedSince(tx, input.businessId, subscriptionId, input.boughtAt)) {
      await replaceLivePacksInTransaction(tx, { businessId: input.businessId, at: input.now });
      logEvent("info", "ops.billing.pack_gave_way", { businessId: input.businessId, packId: input.packId, subscriptionId });
      return "gave_way";
    }
    if (account.billingInterval === "annual" || account.subscriptionState === "past_due") {
      logEvent("warn", "ops.billing.pack_beside_subscription", { businessId: input.businessId, packId: input.packId, reason: account.billingInterval === "annual" ? "annual" : "past_due" });
      return "beside";
    }
    // The plan, its state and its subscription stay as the provider reports them, so no later event reads as a new start.
    await tx.update(billingAccounts).set({ replacedSubscriptionId: subscriptionId, allowancesSince: input.now, updatedAt: input.now })
      .where(and(eq(billingAccounts.businessId, input.businessId), eq(billingAccounts.subscriptionId, subscriptionId)));
    await enqueueOutbox(tx, { topic: "billing.endPlanForPack", businessId: input.businessId, aggregateType: "billing_account", aggregateId: input.businessId, dedupeKey: `end-plan-for-pack:${subscriptionId}`, payload: { subscriptionId, packId: input.packId, since: input.now.toISOString() } });
    return "replaced";
  }
  if (input.hadLivePacks) return "topped_up";
  await tx.update(billingAccounts).set({ allowancesSince: input.now, updatedAt: input.now }).where(eq(billingAccounts.businessId, input.businessId));
  return "started";
}

/**
 * Whether the subscription started after the business started buying the
 * pack: the first event LobbyStack stored about it is later. False without
 * any, so a subscription LobbyStack knew no event of is treated as the older.
 */
async function subscribedSince(tx: DatabaseTransaction, businessId: string, subscriptionId: string, since: Date): Promise<boolean> {
  const [first] = await tx.select({ at: min(providerEvents.createdAt) }).from(providerEvents)
    .where(and(eq(providerEvents.businessId, businessId), eq(providerEvents.status, "processed"), sql`${providerEvents.payload}->>'subscriptionId' = ${subscriptionId}`));
  const at = first?.at ? new Date(first.at) : null;
  return at !== null && at > since;
}

type PaymentHistory = { refundedCents: number; dispute: "opened" | "won" | "lost" | null };

/** What Stripe's processed refunds and disputes said about a payment: the most refunded, and how a dispute stands. */
async function stripePaymentHistory(tx: DatabaseTransaction, businessId: string, paymentRef: string): Promise<PaymentHistory> {
  const rows = await tx.select({ payload: providerEvents.payload }).from(providerEvents)
    .where(and(eq(providerEvents.businessId, businessId), eq(providerEvents.provider, "stripe"), eq(providerEvents.status, "processed"), sql`${providerEvents.payload}->>'paymentRef' = ${paymentRef}`, sql`${providerEvents.payload}->>'kind' in ('refund', 'dispute')`))
    .orderBy(providerEvents.createdAt);
  const history: PaymentHistory = { refundedCents: 0, dispute: null };
  for (const row of rows) {
    const payload = recordObject(row.payload);
    if (payload.kind === "refund") history.refundedCents = Math.max(history.refundedCents, numberField(payload, "refundedAmount") ?? 0);
    const outcome = stringField(payload, "disputeOutcome");
    // A closed dispute stays closed, whatever order its events came in.
    if (outcome === "won" || outcome === "lost" || (outcome === "opened" && history.dispute === null)) history.dispute = outcome;
  }
  return history;
}

/** The pack a Stripe checkout bought: the pack checkout it names, else the price, else the pack's code. */
async function packOfStripeCheckout(tx: DatabaseTransaction, businessId: string, payload: Record<string, unknown>): Promise<BoughtPack | null> {
  const checkoutId = stringField(payload, "packCheckoutId");
  // A uuid column compared with anything else fails the statement, and the event would never apply.
  if (checkoutId && isUuid(checkoutId)) {
    const [checkout] = await tx.select({ pack: billingPackCheckouts.pack, priceId: billingPackCheckouts.priceId }).from(billingPackCheckouts)
      .where(and(eq(billingPackCheckouts.id, checkoutId), eq(billingPackCheckouts.businessId, businessId))).limit(1);
    const terms = checkout ? await readPackPlan(tx, checkout.pack) : null;
    if (checkout && terms) return { terms, priceId: checkout.priceId };
  }
  const priceRef = stringField(payload, "packPriceRef");
  const byPrice = priceRef ? await packOfPrice(tx, priceRef) : null;
  if (byPrice) return byPrice;
  const code = stringField(payload, "packCode");
  const terms = code ? await readPackPlan(tx, code) : null;
  return terms ? { terms, priceId: null } : null;
}

/** The pack a price sells, by LobbyStack's price id or the provider's object (a Stripe price or a Polar product), a retired one too. */
async function packOfPrice(tx: DatabaseTransaction, reference: string): Promise<BoughtPack | null> {
  const [price] = await tx.select({ id: billingPackPrices.id, pack: billingPackPrices.pack }).from(billingPackPrices)
    .where(isUuid(reference) ? eq(billingPackPrices.id, reference) : eq(billingPackPrices.providerRef, reference)).limit(1);
  const terms = price ? await readPackPlan(tx, price.pack) : null;
  return price && terms ? { terms, priceId: price.id } : null;
}

/** The pack checkout a Polar checkout belongs to. */
async function packCheckoutOf(tx: DatabaseTransaction, businessId: string, providerCheckoutId: string | undefined): Promise<string | undefined> {
  if (!providerCheckoutId) return undefined;
  const [checkout] = await tx.select({ id: billingPackCheckouts.id }).from(billingPackCheckouts)
    .where(and(eq(billingPackCheckouts.businessId, businessId), eq(billingPackCheckouts.checkoutId, providerCheckoutId))).limit(1);
  return checkout?.id;
}

/** When a Stripe checkout session was made, from its own created time. */
function checkoutStartedAt(payload: Record<string, unknown>): Date | undefined {
  const created = numberField(payload, "created");
  return created === undefined ? undefined : new Date(created * 1_000);
}

/**
 * Records a pack checkout's outcome. Paid wins over anything else and never
 * goes back; failed and expired end only a checkout still open. The screen
 * polling the checkout hears of it.
 */
async function settlePackCheckout(tx: DatabaseTransaction, input: { businessId: string; checkoutId: string; status: "paid" | "failed" | "expired" }): Promise<void> {
  if (!isUuid(input.checkoutId)) return;
  // Paid as markPackCheckoutPaidInTransaction marks it, without importing it: billingPackCheckout imports billing, which imports this module.
  const from = input.status === "paid" ? ["pending", "processing", "ready", "failed", "expired"] : ["pending", "processing", "ready"];
  const [settled] = await tx.update(billingPackCheckouts)
    .set({ status: input.status, error: input.status === "failed" ? "The payment didn't go through." : null, updatedAt: new Date() })
    .where(and(eq(billingPackCheckouts.id, input.checkoutId), eq(billingPackCheckouts.businessId, input.businessId), inArray(billingPackCheckouts.status, from)))
    .returning({ id: billingPackCheckouts.id });
  if (settled) {
    await enqueueOutbox(tx, { topic: "realtime.publish", businessId: input.businessId, aggregateType: "billing_pack_checkout", aggregateId: settled.id, dedupeKey: `billing-pack-checkout:${settled.id}:${input.status}`, payload: { type: "billing.updated", entityId: settled.id } });
  }
}

/** The order row of a provider order or invoice, once its own event made it. */
async function orderRowOf(tx: DatabaseTransaction, sourceId: string): Promise<string | null> {
  const [row] = await tx.select({ id: billingTransactions.id }).from(billingTransactions).where(and(eq(billingTransactions.kind, "order"), eq(billingTransactions.sourceId, sourceId))).limit(1);
  return row?.id ?? null;
}

/**
 * The order row of a pack paid through Stripe as merchant of record, which
 * makes no invoice: keyed on the PaymentIntent, as its refunds are. A refund
 * written first keeps its status and amount; commission follows the rest.
 */
async function recordStripePackOrder(tx: DatabaseTransaction, input: { businessId: string; paymentRef: string; amountCents: number; refundedCents: number; currency: string; customerId: string | undefined; occurredAt: Date }): Promise<string> {
  const status = input.refundedCents <= 0 ? "paid" : input.refundedCents >= input.amountCents ? "refunded" : "partially_refunded";
  const [order] = await tx.insert(billingTransactions).values({
    businessId: input.businessId,
    kind: "order",
    sourceId: input.paymentRef,
    orderId: input.paymentRef,
    status,
    amountCents: input.amountCents,
    refundedAmountCents: input.refundedCents,
    currency: input.currency,
    ...(input.customerId ? { providerCustomerId: input.customerId } : {}),
    occurredAt: input.occurredAt,
    lastSyncedAt: new Date(),
  }).onConflictDoUpdate({
    target: [billingTransactions.kind, billingTransactions.sourceId],
    set: {
      amountCents: input.amountCents,
      refundedAmountCents: sql`greatest(${billingTransactions.refundedAmountCents}, excluded.refunded_amount_cents)`,
      status: sql`case when greatest(${billingTransactions.refundedAmountCents}, excluded.refunded_amount_cents) >= excluded.amount_cents then 'refunded' when greatest(${billingTransactions.refundedAmountCents}, excluded.refunded_amount_cents) > 0 then 'partially_refunded' else 'paid' end`,
      ...(input.customerId ? { providerCustomerId: input.customerId } : {}),
      occurredAt: input.occurredAt,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    },
  }).returning({ id: billingTransactions.id, status: billingTransactions.status, amountCents: billingTransactions.amountCents, refundedAmountCents: billingTransactions.refundedAmountCents, currency: billingTransactions.currency, occurredAt: billingTransactions.occurredAt });
  if (!order) throw new Error("Billing transaction could not be persisted.");
  await recordAffiliateCommissionInTransaction(tx, { businessId: input.businessId, billingTransactionId: order.id, kind: "order", sourceId: input.paymentRef, status: order.status, amountCents: order.amountCents - order.refundedAmountCents, currency: order.currency, occurredAt: order.occurredAt });
  return order.id;
}

/**
 * What follows a pack's change: its receptionist allowance may differ, the
 * expiry job settles a pack that ended (the number's release once no live pack
 * is left), and open screens refresh.
 */
async function afterPackChange(tx: DatabaseTransaction, businessId: string, change: PackChange): Promise<void> {
  if (change.status === change.previous) return;
  await enqueueReceptionistAllowanceCheck(tx, businessId, "billing_pack");
  if (change.status === "refunded" || change.status === "expired") {
    await enqueueOutbox(tx, { topic: "billing.expirePacks", businessId, aggregateType: "billing_pack", aggregateId: change.packId, dedupeKey: `billing-pack:${change.packId}:ended:run`, payload: { reason: "ended" } });
  }
  await publishPackUpdate(tx, businessId, change.packId, change.status);
}

async function publishPackUpdate(tx: DatabaseTransaction, businessId: string, packId: string, status: string): Promise<void> {
  await enqueueOutbox(tx, { topic: "realtime.publish", businessId, aggregateType: "billing_account", aggregateId: businessId, dedupeKey: `billing:${businessId}:pack:${packId}:${status}:${Date.now()}`, payload: { type: "billing.updated", entityId: businessId } });
}
