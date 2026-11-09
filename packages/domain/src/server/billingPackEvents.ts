import { and, eq, gt, inArray, isNull, min, or, sql } from "drizzle-orm";

import { auditLogs, billingAccounts, billingPackCheckouts, billingPackPrices, billingPacks, billingTransactions, enqueueOutbox, providerEvents, type DatabaseTransaction } from "@lobbystack/db";
import { isPaidSubscription, isReplacedSubscription, isUuid, isYearlyBillingInterval, liveSubscriptionStates } from "@lobbystack/shared";
import { getPostHogDistinctIdForBusinessSystem } from "@lobbystack/telemetry";
import { logEvent } from "@lobbystack/telemetry/node";

import { recordAffiliateCommissionInTransaction } from "./affiliates";
import { dateField, numberField, recordObject, stringField } from "./billingFields";
import {
  applyPackRefundInTransaction,
  clearPackNumberReleaseInTransaction,
  closePackDisputeInTransaction,
  endedPackStatuses,
  freezePackInTransaction,
  readLivePacks,
  readPackCheckoutTerms,
  readPackPlan,
  recordPackPurchaseInTransaction,
  replaceLivePacksInTransaction,
  lockBusinessPacks,
  PACK_CHECKOUT_CLOSED_FOR_PLAN,
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
// - A payment already wholly refunded, or whose dispute was lost, before it
//   arrived adds its pack as ended, and switches the business onto nothing.
// - The pack gets the terms its checkout kept from when the business asked for
//   it (0149), so a catalog change meanwhile never gives less than was paid for.
// - Decision 6, subscription to pack: a payment that finds a live monthly Starter
//   or Pro subscription marks it replaced, which LobbyStack treats as ended from
//   then on, starts the pack's allowances, and queues billing.endPlanForPack to
//   end it at the provider. A yearly or past-due one stays (the checkout refuses
//   both, decisions 6a and 6b), and so does an operator's managed plan; the pack
//   waits beside it and ops.billing.pack_beside_subscription reports it.
// - Decision 6, pack to subscription: a subscription that starts ends the live
//   packs (packsGiveWayToSubscriptionInTransaction) and starts its allowances.
//   It also closes the business's open pack checkouts, since a pack paid after
//   the plan started would end at once. A pack paid anyway, on a page the
//   provider couldn't close or by a payment that settled later, gives way to
//   the plan: LobbyStack refunds nothing on its own (decision 5), so
//   ops.billing.pack_gave_way and an audit row name the payment to refund.
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

/** Which pack a payment bought: the terms its checkout kept, else the catalog's now, and the price it was sold at. */
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
 * The business's open pack checkouts close too (closePackCheckoutsForPlan).
 * A pack paid after the subscription went live gave way to it, and is
 * reported with the payment to refund, as switchToPack reports one whose
 * payment arrives once the subscription is live. One paid before was in force
 * until the plan started, so it ends as decision 6 says, unreported; a
 * payment from before the plan went live that arrives after its start is
 * reported by switchToPack all the same, since that pack was never in force.
 * Returns the packs it ended; none for a business without a live pack.
 */
export async function packsGiveWayToSubscriptionInTransaction(tx: DatabaseTransaction, input: { businessId: string; at: Date; subscription?: { id: string; liveSince: Date } }): Promise<string[]> {
  const replaced = await replaceLivePacksInTransaction(tx, input);
  await clearPackNumberReleaseInTransaction(tx, input.businessId);
  if (replaced.length) {
    await tx.update(billingAccounts).set({ allowancesSince: input.at, updatedAt: input.at }).where(eq(billingAccounts.businessId, input.businessId));
    for (const pack of replaced) await publishPackUpdate(tx, input.businessId, pack.id, "replaced");
  }
  const subscription = input.subscription;
  if (subscription) {
    for (const pack of replaced) {
      if (pack.paidAt <= subscription.liveSince) continue;
      await reportPackGaveWay(tx, { businessId: input.businessId, packId: pack.id, subscriptionId: subscription.id, payment: { pack: pack.pack, provider: pack.provider, providerRef: pack.providerRef, amountCents: pack.amountCents, currency: pack.currency } });
    }
  }
  await closePackCheckoutsForPlan(tx, input);
  return replaced.map((pack) => pack.id);
}

/**
 * When a subscription that just started went live, by the provider's clock,
 * which a pack's paid_at is compared with. The event as the provider sent it
 * says, not as a read-back merged it, whose time is only when LobbyStack
 * looked: the event's own time when it shows the subscription live, else
 * when LobbyStack read it back live, else when LobbyStack received the event.
 * For a subscription new to the account, its start at the provider when that
 * is earlier, so the answer holds whichever of its events came first. Stripe
 * stamps seconds (start_date, created), Polar ISO times (started_at,
 * created_at).
 */
export function subscriptionLiveSince(event: Record<string, unknown>, input: { eventCreatedAt: Date; readAt?: Date | undefined; newToAccount: boolean }): Date {
  const eventAt = (showsLive(event) ? dateField(event, "subscriptionModifiedAt") ?? dateField(event, "occurredAt") : undefined) ?? input.readAt ?? input.eventCreatedAt;
  if (!input.newToAccount) return eventAt;
  const providerStart = [unixSeconds(event.start_date), unixSeconds(event.created), dateField(event, "started_at"), dateField(event, "created_at")]
    .filter((at): at is Date => at !== undefined);
  return new Date(Math.min(eventAt.getTime(), ...providerStart.map((at) => at.getTime())));
}

/**
 * Whether an event, as sent, shows its subscription live: in a live state, or
 * a paid payment, such as the invoice that paid an unpaid subscription. One
 * sent before then and applied late says nothing of when it went live.
 */
function showsLive(event: Record<string, unknown>): boolean {
  const kind = stringField(event, "kind");
  const state = stringField(event, "subscriptionState") ?? (kind === "subscription" ? stringField(event, "status") : undefined);
  if (state !== undefined) return (liveSubscriptionStates as readonly string[]).includes(state);
  return kind === "payment" && stringField(event, "status") === "paid";
}

function unixSeconds(value: unknown): Date | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1000) : undefined;
}

/**
 * Closes the business's pack checkouts still open when a subscription went
 * live: one still being made fails, so no page is made for it, and a page
 * already made, until its expiry, expires, and billing.closePackCheckout asks
 * the provider to close it (Stripe expires its Checkout Session; Polar has no
 * such call, so its page stays payable until its own expiry). Their pages
 * hear of it. A business that never bought a pack has none.
 */
async function closePackCheckoutsForPlan(tx: DatabaseTransaction, input: { businessId: string; at: Date }): Promise<void> {
  const openStatuses = ["pending", "processing", "ready"];
  // Read first, locking what is open, so a business without an open pack checkout has nothing written.
  // A page still being made can be made after its request's 15 minutes, so it closes whatever its expiry says.
  const open = await tx.select({ id: billingPackCheckouts.id }).from(billingPackCheckouts)
    .where(and(eq(billingPackCheckouts.businessId, input.businessId), or(inArray(billingPackCheckouts.status, ["pending", "processing"]), and(eq(billingPackCheckouts.status, "ready"), gt(billingPackCheckouts.expiresAt, input.at)))))
    .for("update");
  if (!open.length) return;
  const closed = await tx.update(billingPackCheckouts)
    .set({ status: sql`case when ${billingPackCheckouts.status} = 'ready' then 'expired' else 'failed' end`, error: PACK_CHECKOUT_CLOSED_FOR_PLAN, updatedAt: input.at })
    .where(and(eq(billingPackCheckouts.businessId, input.businessId), inArray(billingPackCheckouts.id, open.map((checkout) => checkout.id)), inArray(billingPackCheckouts.status, openStatuses)))
    .returning({ id: billingPackCheckouts.id, status: billingPackCheckouts.status, checkoutId: billingPackCheckouts.checkoutId });
  for (const checkout of closed) {
    if (checkout.status === "expired" && checkout.checkoutId) {
      await enqueueOutbox(tx, { topic: "billing.closePackCheckout", businessId: input.businessId, aggregateType: "billing_pack_checkout", aggregateId: checkout.id, dedupeKey: `billing-pack-checkout:${checkout.id}:close`, payload: { checkoutId: checkout.id, providerCheckoutId: checkout.checkoutId } });
    }
    await enqueueOutbox(tx, { topic: "realtime.publish", businessId: input.businessId, aggregateType: "billing_pack_checkout", aggregateId: checkout.id, dedupeKey: `billing-pack-checkout:${checkout.id}:${checkout.status}`, payload: { type: "billing.updated", entityId: checkout.id } });
  }
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
  const customerId = stringField(payload, "customerId");
  const transactionId = invoiceRef
    ? await invoiceOrderRow(tx, { businessId: input.businessId, invoiceRef, amountCents, currency, customerId, occurredAt: paidAt })
    : await recordStripePackOrder(tx, { businessId: input.businessId, paymentRef, amountCents, refundedCents: Math.min(history.refundedCents, amountCents), currency, customerId, occurredAt: paidAt });
  await recordPurchase(tx, input, { bought, providerRef: paymentRef, amountCents, currency, paidAt, transactionId, boughtAt: checkoutStartedAt(payload) ?? paidAt, history, checkoutId: checkoutId && isUuid(checkoutId) ? checkoutId : undefined });
}

async function applyPolarPackOrder(tx: DatabaseTransaction, input: PackEventInput, order: NonNullable<PackEventInput["order"]>): Promise<boolean> {
  if (!order.productId || !["paid", "partially_refunded", "refunded"].includes(order.status)) return false;
  // The order names Polar's product, which the catalog's link keeps as the price's provider_ref. A Polar product id
  // is a uuid, as LobbyStack's own price ids are, so it is matched on provider_ref only.
  const byPrice = await packOfPrice(tx, { providerRef: order.productId });
  if (!byPrice) return false;
  const named = stringField(order.metadata, "lobbystack_pack_checkout");
  const checkoutId = (named && isUuid(named) ? named : undefined) ?? await packCheckoutOf(tx, input.businessId, order.checkoutId);
  // The terms the checkout kept from when the business asked, for the pack the order paid for, else the catalog's.
  const kept = checkoutId ? await packOfCheckout(tx, input.businessId, checkoutId) : null;
  const bought = kept?.terms.code === byPrice.terms.code ? kept : byPrice;
  if (checkoutId) await settlePackCheckout(tx, { businessId: input.businessId, checkoutId, status: "paid" });
  // As on Stripe, the pack is ordered against a subscription from when the business asked for its checkout, so a
  // subscription bought while the payment page was open is the later choice and wins.
  const boughtAt = (checkoutId ? await packCheckoutCreatedAt(tx, input.businessId, checkoutId) : undefined) ?? order.occurredAt;
  // The order carries its refunds, so whichever of its events comes first adds the pack with them, and a pack whose
  // payment went back wholly before it arrived switches nothing.
  await recordPurchase(tx, input, { bought, providerRef: order.orderId, amountCents: order.amountCents, currency: order.currency, paidAt: order.occurredAt, transactionId: order.transactionId, boughtAt, history: { refundedCents: order.refundedCents, dispute: null }, checkoutId });
  const refund = await applyPackRefundInTransaction(tx, { businessId: input.businessId, provider: "polar", providerRef: order.orderId, refundedCents: order.refundedCents, at: input.eventCreatedAt });
  if (refund) await afterPackChange(tx, input.businessId, refund);
  return true;
}

async function applyStripePackDispute(tx: DatabaseTransaction, input: PackEventInput): Promise<boolean> {
  const paymentRef = stringField(input.payload, "paymentRef");
  if (!paymentRef) return false;
  const change = await applyDispute(tx, input.businessId, paymentRef, stringField(input.payload, "disputeOutcome"), dateField(input.payload, "occurredAt") ?? input.eventCreatedAt, stringField(input.payload, "id"));
  if (change) await afterPackChange(tx, input.businessId, change);
  return change !== null;
}

/** A Stripe dispute's opening or close. An opening of disputeId leaves a live pack live when that dispute's close was applied first. */
async function applyDispute(tx: DatabaseTransaction, businessId: string, paymentRef: string, outcome: string | undefined, at: Date, disputeId?: string): Promise<PackChange | null> {
  if (outcome === "opened") return await freezePackInTransaction(tx, { businessId, provider: "stripe", providerRef: paymentRef, ...(disputeId ? { alreadyClosed: () => stripeDisputeClosed(tx, businessId, disputeId) } : {}) });
  if (outcome === "won" || outcome === "lost") return await closePackDisputeInTransaction(tx, { businessId, provider: "stripe", providerRef: paymentRef, won: outcome === "won", at });
  return null;
}

/**
 * Whether Stripe's close of this dispute was applied already: its events can
 * be applied in either order. Matched on the dispute, not the payment, since
 * an inquiry closed without a chargeback can be followed by a dispute of the
 * same payment, which freezes the pack again.
 */
async function stripeDisputeClosed(tx: DatabaseTransaction, businessId: string, disputeId: string): Promise<boolean> {
  const [closed] = await tx.select({ id: providerEvents.id }).from(providerEvents)
    .where(and(eq(providerEvents.businessId, businessId), eq(providerEvents.provider, "stripe"), eq(providerEvents.status, "processed"), eq(providerEvents.eventType, "charge.dispute.closed"), sql`${providerEvents.payload}->>'id' = ${disputeId}`))
    .limit(1);
  return closed !== undefined;
}

type Purchase = {
  bought: BoughtPack;
  providerRef: string;
  amountCents: number;
  currency: string;
  paidAt: Date;
  transactionId: string | null;
  /** When the business started buying it, which orders it against a subscription bought meanwhile when its checkout kept no record of the one live then. */
  boughtAt: Date;
  history: PaymentHistory;
  /** The pack checkout the payment settled, which names the pack once it's added. */
  checkoutId: string | undefined;
};

/** The payment a pack came with, as ops.billing.pack_gave_way names it for a refund. */
type PackPayment = { pack: string; provider: "polar" | "stripe"; providerRef: string; amountCents: number; currency: string };

/**
 * Adds the pack once, and on the first delivery switches the business onto
 * it. A payment wholly refunded, or whose dispute was lost, before it arrived
 * adds the pack as ended: the expiry job settles it, and the business stays on
 * the plan it has, with its allowances and number as they are.
 */
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
  if (purchase.checkoutId) await linkPackCheckout(tx, { businessId: input.businessId, checkoutId: purchase.checkoutId, packId: recorded.packId });
  if (!recorded.created) return;
  let status: PackChange["status"] = "active";
  if (purchase.history.refundedCents > 0) status = (await applyPackRefundInTransaction(tx, { businessId: input.businessId, provider, providerRef: purchase.providerRef, refundedCents: purchase.history.refundedCents, at: now }))?.status ?? status;
  if (purchase.history.dispute) {
    status = (await freezePackInTransaction(tx, { businessId: input.businessId, provider, providerRef: purchase.providerRef }))?.status ?? status;
    if (purchase.history.dispute !== "opened") status = (await applyDispute(tx, input.businessId, purchase.providerRef, purchase.history.dispute, now))?.status ?? status;
  }
  if ((endedPackStatuses as readonly string[]).includes(status)) {
    // The payment went back before it arrived: nothing to switch onto, so the account, its allowances and the number
    // stay. The pack was never in force, so its end is settled already, and no number's release starts from it.
    await tx.update(billingPacks).set({ notices: sql`array_append(${billingPacks.notices}, 'ended')`, updatedAt: now })
      .where(and(eq(billingPacks.id, recorded.packId), sql`not ('ended' = any(${billingPacks.notices}))`));
    await afterPackChange(tx, input.businessId, { packId: recorded.packId, status, previous: "active" });
    return;
  }
  const payment: PackPayment = { pack: purchase.bought.terms.code, provider, providerRef: purchase.providerRef, amountCents: purchase.amountCents, currency: purchase.currency };
  const asked = await subscriptionWhenAsked(tx, input.businessId, purchase.checkoutId);
  const switched = await switchToPack(tx, { businessId: input.businessId, packId: recorded.packId, account: input.account, hadLivePacks, boughtAt: purchase.boughtAt, asked, now, payment });
  // The number a business keeps through a pack stays when another pack comes before its release.
  if (switched !== "gave_way") await clearPackNumberReleaseInTransaction(tx, input.businessId);
  // A pack's receptionist allowance can be below the plan it replaces: the newest receptionists past it pause.
  await enqueueReceptionistAllowanceCheck(tx, input.businessId, "billing_pack");
  await publishPackUpdate(tx, input.businessId, recorded.packId, switched === "gave_way" ? "replaced" : "active");
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
 * the pack, so the subscription is its latest choice and the pack ends at once;
 * nothing refunds it (decision 5), so it is reported with the payment to
 * refund. started: from Free, the pack's allowances count from now.
 * topped_up: another pack was live, so nothing changes.
 */
async function switchToPack(tx: DatabaseTransaction, input: { businessId: string; packId: string; account: PackSwitchAccount | undefined; hadLivePacks: boolean; boughtAt: Date; asked: SubscriptionWhenAsked | undefined; now: Date; payment: PackPayment }): Promise<Switch> {
  const account = input.account;
  if (account?.managed) {
    logEvent("warn", "ops.billing.pack_beside_subscription", { businessId: input.businessId, packId: input.packId, reason: "managed" });
    return "beside";
  }
  const subscriptionId = account?.subscriptionId ?? null;
  if (account && subscriptionId && !isReplacedSubscription(account) && isPaidSubscription(account.plan, account.subscriptionState)) {
    if (await subscribedSince(tx, { businessId: input.businessId, subscriptionId, since: input.boughtAt, asked: input.asked })) {
      await replaceLivePacksInTransaction(tx, { businessId: input.businessId, at: input.now });
      await reportPackGaveWay(tx, { businessId: input.businessId, packId: input.packId, subscriptionId, payment: input.payment });
      return "gave_way";
    }
    if (isYearlyBillingInterval(account.billingInterval) || account.subscriptionState === "past_due") {
      logEvent("warn", "ops.billing.pack_beside_subscription", { businessId: input.businessId, packId: input.packId, reason: isYearlyBillingInterval(account.billingInterval) ? "annual" : "past_due" });
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
 * ops.billing.pack_gave_way: a pack paid after its business subscribed ended
 * at once, and its payment stays with LobbyStack's operator, who refunds it in
 * the provider's dashboard; the refund's event then lands on the ended pack.
 * A warning log line, the ops event and an audit row, each naming the payment.
 */
async function reportPackGaveWay(tx: DatabaseTransaction, input: { businessId: string; packId: string; subscriptionId: string; payment: PackPayment }): Promise<void> {
  const { businessId, packId, subscriptionId, payment } = input;
  logEvent("warn", "ops.billing.pack_gave_way", { businessId, packId, subscriptionId, ...payment });
  await tx.insert(auditLogs).values({ businessId, eventType: "billing.pack_gave_way", entityType: "billing_pack", entityId: packId, payload: { ...payment, subscriptionId } });
  await recordProductEventInTransaction(tx, {
    name: "ops.billing.pack_gave_way",
    distinctId: getPostHogDistinctIdForBusinessSystem(businessId),
    businessId,
    actorType: "worker",
    properties: { provider: payment.provider, pack: payment.pack, providerRef: payment.providerRef, amountCents: payment.amountCents, currency: payment.currency },
  });
}

/**
 * Whether the business subscribed after it started buying the pack, which
 * makes the subscription its latest choice. The pack's checkout says, from
 * 0149: it names the subscription live when the business asked for it, so a
 * live one it doesn't name, a new one or one not live then, such as an unpaid
 * subscription paid since, came later, whatever order the subscription's
 * events arrived in. Without it, for a payment that names no checkout of the
 * business or a checkout from before 0149, the first event LobbyStack stored
 * about the subscription is later. False without any, so a subscription
 * LobbyStack knew no event of is treated as the older.
 */
async function subscribedSince(tx: DatabaseTransaction, input: { businessId: string; subscriptionId: string; since: Date; asked: SubscriptionWhenAsked | undefined }): Promise<boolean> {
  if (input.asked) return input.asked.subscriptionId !== input.subscriptionId;
  const [first] = await tx.select({ at: min(providerEvents.createdAt) }).from(providerEvents)
    .where(and(eq(providerEvents.businessId, input.businessId), eq(providerEvents.status, "processed"), sql`${providerEvents.payload}->>'subscriptionId' = ${input.subscriptionId}`));
  const at = first?.at ? new Date(first.at) : null;
  return at !== null && at > input.since;
}

/** The subscription a pack checkout found live when the business asked for it, which its payment replaces; null when it found none. */
type SubscriptionWhenAsked = { subscriptionId: string | null };

/**
 * What a pack checkout of the business kept of the subscription live when it
 * was asked for (0149). Undefined without one to read: no checkout, or a row
 * from before 0149, which kept no terms either.
 */
async function subscriptionWhenAsked(tx: DatabaseTransaction, businessId: string, checkoutId: string | undefined): Promise<SubscriptionWhenAsked | undefined> {
  // A uuid column compared with anything else fails the statement, and the event would never apply.
  if (!checkoutId || !isUuid(checkoutId)) return undefined;
  const [checkout] = await tx.select({ terms: billingPackCheckouts.terms, subscriptionId: billingPackCheckouts.subscriptionId }).from(billingPackCheckouts)
    .where(and(eq(billingPackCheckouts.id, checkoutId), eq(billingPackCheckouts.businessId, businessId))).limit(1);
  return checkout && checkout.terms !== null ? { subscriptionId: checkout.subscriptionId } : undefined;
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
  const byCheckout = checkoutId ? await packOfCheckout(tx, businessId, checkoutId) : null;
  if (byCheckout) return byCheckout;
  // The worker puts LobbyStack's own price id on the payment, and a Stripe price id is never a uuid.
  const priceRef = stringField(payload, "packPriceRef");
  const byPrice = priceRef ? await packOfPrice(tx, isUuid(priceRef) ? { id: priceRef } : { providerRef: priceRef }) : null;
  if (byPrice) return byPrice;
  const code = stringField(payload, "packCode");
  const terms = code ? await readPackPlan(tx, code) : null;
  return terms ? { terms, priceId: null } : null;
}

/**
 * The pack a price sells, a retired one too: by LobbyStack's price id, or by
 * the provider's object that sells it (a Stripe price or a Polar product). The
 * caller names the column, since a uuid can be either.
 */
async function packOfPrice(tx: DatabaseTransaction, reference: { id: string } | { providerRef: string }): Promise<BoughtPack | null> {
  const [price] = await tx.select({ id: billingPackPrices.id, pack: billingPackPrices.pack }).from(billingPackPrices)
    .where("id" in reference ? eq(billingPackPrices.id, reference.id) : eq(billingPackPrices.providerRef, reference.providerRef)).limit(1);
  const terms = price ? await readPackPlan(tx, price.pack) : null;
  return price && terms ? { terms, priceId: price.id } : null;
}

/**
 * The pack a pack checkout of the business sold: the terms it kept when the
 * business asked for it (0149), else the catalog's for a row from before
 * them. Null for a checkout the business doesn't have.
 */
async function packOfCheckout(tx: DatabaseTransaction, businessId: string, checkoutId: string): Promise<BoughtPack | null> {
  // A uuid column compared with anything else fails the statement, and the event would never apply.
  if (!isUuid(checkoutId)) return null;
  const [checkout] = await tx.select({ pack: billingPackCheckouts.pack, priceId: billingPackCheckouts.priceId, terms: billingPackCheckouts.terms }).from(billingPackCheckouts)
    .where(and(eq(billingPackCheckouts.id, checkoutId), eq(billingPackCheckouts.businessId, businessId))).limit(1);
  if (!checkout) return null;
  const terms = readPackCheckoutTerms(checkout.pack, checkout.terms) ?? await readPackPlan(tx, checkout.pack);
  return terms ? { terms, priceId: checkout.priceId } : null;
}

/** Names on a pack checkout the pack its payment added, so its page can tell what became of it. */
async function linkPackCheckout(tx: DatabaseTransaction, input: { businessId: string; checkoutId: string; packId: string }): Promise<void> {
  if (!isUuid(input.checkoutId)) return;
  await tx.update(billingPackCheckouts).set({ packId: input.packId, updatedAt: new Date() })
    .where(and(eq(billingPackCheckouts.id, input.checkoutId), eq(billingPackCheckouts.businessId, input.businessId), isNull(billingPackCheckouts.packId)));
}

/** The pack checkout a Polar checkout belongs to. */
async function packCheckoutOf(tx: DatabaseTransaction, businessId: string, providerCheckoutId: string | undefined): Promise<string | undefined> {
  if (!providerCheckoutId) return undefined;
  const [checkout] = await tx.select({ id: billingPackCheckouts.id }).from(billingPackCheckouts)
    .where(and(eq(billingPackCheckouts.businessId, businessId), eq(billingPackCheckouts.checkoutId, providerCheckoutId))).limit(1);
  return checkout?.id;
}

/** When the business asked for a pack checkout, or undefined for a checkout it doesn't have. */
async function packCheckoutCreatedAt(tx: DatabaseTransaction, businessId: string, checkoutId: string): Promise<Date | undefined> {
  // A uuid column compared with anything else fails the statement, and the event would never apply.
  if (!isUuid(checkoutId)) return undefined;
  const [checkout] = await tx.select({ createdAt: billingPackCheckouts.createdAt }).from(billingPackCheckouts)
    .where(and(eq(billingPackCheckouts.id, checkoutId), eq(billingPackCheckouts.businessId, businessId))).limit(1);
  return checkout?.createdAt;
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
 * The order row of the invoice Stripe directly makes for a pack's payment.
 * Stripe sends the invoice's events and the checkout's in any order, so when
 * the invoice's own event hasn't made the row yet, it is made here, paid, for
 * the pack to name. The invoice's event then fills in the rest on the same
 * row, by its status's rank, and records the commission, as for any invoice.
 */
async function invoiceOrderRow(tx: DatabaseTransaction, input: { businessId: string; invoiceRef: string; amountCents: number; currency: string; customerId: string | undefined; occurredAt: Date }): Promise<string | null> {
  const existing = await orderRowOf(tx, input.invoiceRef);
  if (existing) return existing;
  await tx.insert(billingTransactions).values({
    businessId: input.businessId,
    kind: "order",
    sourceId: input.invoiceRef,
    orderId: input.invoiceRef,
    status: "paid",
    amountCents: input.amountCents,
    refundedAmountCents: 0,
    currency: input.currency,
    ...(input.customerId ? { providerCustomerId: input.customerId } : {}),
    occurredAt: input.occurredAt,
    lastSyncedAt: new Date(),
  }).onConflictDoNothing({ target: [billingTransactions.kind, billingTransactions.sourceId] });
  return await orderRowOf(tx, input.invoiceRef);
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
