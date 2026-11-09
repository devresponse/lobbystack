import { and, desc, eq, gte, inArray, isNull, lt, ne, or, type SQL } from "drizzle-orm";

import { billingAccounts, billingCheckoutRequests, billingPackCheckouts, billingPackOffers, billingPackPlans, billingPackPrices, businesses, enqueueOutbox, users, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { billingProviderOf, isUuid } from "@lobbystack/shared";

import { requireBusinessAdmin } from "../authz";
import { BILLING_CHECKOUT_CLAIM_STALE_MS, BILLING_CHECKOUT_EXPIRES_MS, isLiveSubscriptionState, isManagedBillingAccount, isReplacedSubscription, loadPlanChangePayment, lockBillingAccount, OPEN_PURCHASE_REFUSAL, openPackCheckout, type BillingCheckoutClaim, type BillingCheckoutLimit } from "./billing";
import { readBillingDeployment } from "./billingProvider";
import type { DomainContext } from "./context";
import { loadBillingContext } from "./usage";

// Checkouts for prepaid minute packs: the plan checkout's steps in billing.ts,
// kept in a table of their own, billing_pack_checkouts. The dashboard or the
// API makes a row; the billing.createPackCheckout job claims it and asks the
// deployment's provider for a one-time payment page; billing.reconcile marks
// it paid when the payment arrives, as it adds the pack. A business makes one
// purchase at a time: an open plan checkout, subscription change or other
// pack checkout holds a new pack checkout, and an open pack checkout holds
// them (openPackCheckout in billing.ts). A business that never buys a pack
// never has a row here.

/** A pack checkout's statuses: open while pending or processing, ready once its page works, then paid, failed or expired. */
export const packCheckoutStatuses = ["pending", "processing", "ready", "paid", "failed", "expired"] as const;
export type PackCheckoutStatus = (typeof packCheckoutStatuses)[number];

export function isPackCheckoutStatus(value: string | null | undefined): value is PackCheckoutStatus {
  return (packCheckoutStatuses as readonly (string | null | undefined)[]).includes(value);
}

/**
 * The codes of a pack checkout's refusals, which the dashboard's answers carry
 * beside the sentence; the API answers them as its own 409 conflict.
 * plan_change_pending is the plan checkout's own code for another purchase in
 * progress, which the plan screens already know.
 */
export const packCheckoutRefusalCodes = ["managed_plan", "pack_not_sold_on_plan", "pack_yearly_plan", "pack_past_due", "plan_change_payment_waiting", "pack_not_on_sale", "plan_change_pending"] as const;
export type PackCheckoutRefusalCode = (typeof packCheckoutRefusalCodes)[number];

const refused = (code: PackCheckoutRefusalCode, message: string) => Object.assign(new Error(message), { status: 409, code });

/** Why a checkout the job can't make failed when its pack stopped selling between the click and the job. */
export const PACK_NOT_ON_SALE = "This pack isn't on sale right now.";

/** Why a checkout that waited too long for its job failed: nobody waits on its page any more. */
const PACK_CHECKOUT_WAITED = "This request waited too long to run.";

/**
 * How long a page the provider gives no expiry for stays open, as Polar's
 * checkouts do: an hour from when it was made.
 */
export const PACK_CHECKOUT_PAGE_MS = 60 * 60_000;

/**
 * Whether the deployment's provider has what a pack checkout needs: Polar's
 * token and organization, or Stripe's key and account. A pack must also be on
 * sale, which the request checks. Unlike polarCheckoutConfigured, it reads
 * the provider the deployment uses.
 */
export function packCheckoutConfigured(env: Record<string, string | undefined> = process.env): boolean {
  if (billingProviderOf(env) === "stripe") return Boolean(env.STRIPE_API_KEY?.trim() && env.STRIPE_ACCOUNT_ID?.trim());
  return Boolean(env.POLAR_ACCESS_TOKEN && env.POLAR_ORGANIZATION_ID);
}

/** A yearly subscription, as the providers' events and read-backs name its interval. */
function isYearly(interval: string | null | undefined): boolean {
  return interval === "annual" || interval === "year";
}

/** The realtime message that tells a checkout's page its row changed. */
async function publishPackCheckout(tx: DatabaseTransaction, input: { businessId: string; checkoutId: string; status: PackCheckoutStatus }): Promise<void> {
  await enqueueOutbox(tx, { topic: "realtime.publish", businessId: input.businessId, aggregateType: "billing_pack_checkout", aggregateId: input.checkoutId, dedupeKey: `billing-pack-checkout:${input.checkoutId}:${input.status}`, payload: { type: "billing.updated", entityId: input.checkoutId } });
}

/**
 * Queues a checkout for a pack in the name of the person asking. Callers
 * authorize first. Refused with a 409, in this order: a business on a managed
 * plan, as plans are; one on a self-hosted deployment or the Enterprise plan;
 * one with a live yearly subscription, until it ends (decision 6a), or with a
 * payment past due, until it is settled (decision 6b); one whose upgrade still
 * waits on its payment page; and a pack that isn't on sale, which needs a live
 * price a link recorded at the provider. A subscription a pack already
 * replaced counts as ended, so a business on Starter or Pro monthly, or on a
 * pack already, may buy one.
 *
 * The person's open checkout for the same pack and billing email comes back
 * instead of a new one, so a second click asks the provider for nothing;
 * created says which. Any other open purchase of the business, a plan
 * checkout, a cancel, resume or keep, or another pack checkout, is a 409
 * plan_change_pending. checkLimit runs only before a new row is made.
 */
export async function createPackCheckoutRequestInTransaction(
  tx: DatabaseTransaction,
  input: { userId: string; businessId: string; pack: string; billingEmail?: string | undefined; checkLimit?: BillingCheckoutLimit | undefined },
  env: Record<string, string | undefined> = process.env,
): Promise<{ id: string; created: boolean }> {
  // The plan checkout's lock, so a pack and a plan can't both start at once, nor beside reconcile or a managed plan.
  await lockBillingAccount(tx, input.businessId);
  const [account] = await tx.select({ source: billingAccounts.source, subscriptionState: billingAccounts.subscriptionState, subscriptionId: billingAccounts.subscriptionId, replacedSubscriptionId: billingAccounts.replacedSubscriptionId, billingInterval: billingAccounts.billingInterval }).from(billingAccounts).where(eq(billingAccounts.businessId, input.businessId)).limit(1);
  if (isManagedBillingAccount(account)) throw refused("managed_plan", "This business is on a managed plan, billed directly by the operator.");
  const { plan } = await loadBillingContext(tx, input.businessId);
  if (plan === "self_host") throw refused("pack_not_sold_on_plan", "Prepaid packs aren't sold on a self-hosted deployment.");
  if (plan === "enterprise") throw refused("pack_not_sold_on_plan", "Prepaid packs aren't sold to a business on the Enterprise plan.");
  // A subscription the pack would end: the pack's payment replaces it, and a job then ends it at the provider.
  const subscriptionId = account?.subscriptionId && isLiveSubscriptionState(account.subscriptionState) && !isReplacedSubscription(account) ? account.subscriptionId : null;
  if (subscriptionId && isYearly(account?.billingInterval)) throw refused("pack_yearly_plan", "This business pays for a yearly plan. Set it to end at its renewal, and buy a pack once it ends.");
  if (subscriptionId && account?.subscriptionState === "past_due") throw refused("pack_past_due", "This business has a payment past due. Settle it before buying a pack.");
  if (subscriptionId && await loadPlanChangePayment(tx, { businessId: input.businessId, subscriptionId })) throw refused("plan_change_payment_waiting", "An upgrade of this business's plan is waiting for its payment. Pay it, or buy a pack once it expires.");
  const [offer] = await tx.select({ priceId: billingPackOffers.priceId, providerRef: billingPackOffers.providerRef }).from(billingPackOffers).where(eq(billingPackOffers.code, input.pack)).limit(1);
  if (!offer?.providerRef) throw refused("pack_not_on_sale", PACK_NOT_ON_SALE);
  const now = Date.now();
  // Under the lock, so two clicks at once make one row. One older than its 15 minutes fails rather than runs.
  const [open] = await tx.select({ id: billingPackCheckouts.id }).from(billingPackCheckouts).where(and(
    eq(billingPackCheckouts.businessId, input.businessId),
    eq(billingPackCheckouts.requestedByUserId, input.userId),
    inArray(billingPackCheckouts.status, ["pending", "processing"]),
    gte(billingPackCheckouts.createdAt, new Date(now - BILLING_CHECKOUT_EXPIRES_MS)),
    eq(billingPackCheckouts.pack, input.pack),
    input.billingEmail ? eq(billingPackCheckouts.billingEmail, input.billingEmail) : isNull(billingPackCheckouts.billingEmail),
  )).orderBy(desc(billingPackCheckouts.createdAt)).limit(1);
  if (open) return { id: open.id, created: false };
  // One purchase at a time: a plan checkout, a cancel, resume or keep, or another pack checkout still being made holds the business.
  const [request] = await tx.select({ id: billingCheckoutRequests.id }).from(billingCheckoutRequests).where(and(
    eq(billingCheckoutRequests.businessId, input.businessId),
    inArray(billingCheckoutRequests.status, ["pending", "processing"]),
    gte(billingCheckoutRequests.createdAt, new Date(now - BILLING_CHECKOUT_EXPIRES_MS)),
  )).limit(1);
  if (request || await openPackCheckout(tx, input.businessId)) throw refused("plan_change_pending", OPEN_PURCHASE_REFUSAL);
  await input.checkLimit?.({ businessId: input.businessId, userId: input.userId });
  // The account the payment lands on, billed through the deployment's provider, as a plan checkout makes it.
  await tx.insert(billingAccounts).values({ businessId: input.businessId, billingKey: `business:${input.businessId}`, source: readBillingDeployment(env, { withSecret: false }).provider }).onConflictDoNothing({ target: billingAccounts.businessId });
  const [row] = await tx.insert(billingPackCheckouts).values({
    businessId: input.businessId,
    requestedByUserId: input.userId,
    pack: input.pack,
    priceId: offer.priceId,
    status: "pending",
    // The job's 15 minutes; the page's own expiry replaces it once the provider makes one.
    expiresAt: new Date(now + BILLING_CHECKOUT_EXPIRES_MS),
    ...(input.billingEmail ? { billingEmail: input.billingEmail } : {}),
  }).returning({ id: billingPackCheckouts.id });
  if (!row) throw new Error("Pack checkout could not be created.");
  await enqueueOutbox(tx, {
    topic: "billing.createPackCheckout",
    businessId: input.businessId,
    aggregateType: "billing_pack_checkout",
    aggregateId: row.id,
    dedupeKey: `billing-pack-checkout:${row.id}`,
    payload: { checkoutId: row.id },
  });
  return { id: row.id, created: true };
}

/** The dashboard's pack checkout, from one of the business's admins. */
export async function createPackCheckoutRequest(
  context: DomainContext,
  input: { userId: string; businessId: string; pack: string; billingEmail?: string | undefined; checkLimit?: BillingCheckoutLimit | undefined },
): Promise<string> {
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, { userId: input.userId, businessId: input.businessId });
    return (await createPackCheckoutRequestInTransaction(tx, input)).id;
  });
}

/** What billing.createPackCheckout reads: the row, the price the provider sells it at, and who the customer is. */
export type PackCheckoutWork = {
  id: string;
  businessId: string;
  pack: string;
  priceId: string;
  status: string;
  /** The provider's object that sells the pack at the row's price; null once that price is retired, the pack no longer active, or no link recorded one. */
  priceRef: string | null;
  /** The email of the person who asked, which a new provider customer gets unless they gave a billing email. */
  customerEmail: string;
  billingEmail: string | null;
  /** The account's billing key: the external ID of the business's Polar customer. */
  externalCustomerId: string;
  /** The account's customer at the provider, once it has one. */
  customerId: string | null;
  businessName: string;
  onboardingStage: string;
};

export async function loadPackCheckoutRequest(context: DomainContext, input: { businessId: string; checkoutId: string }): Promise<PackCheckoutWork | null> {
  if (!isUuid(input.checkoutId)) return null;
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const [row] = await tx.select({
      id: billingPackCheckouts.id,
      businessId: billingPackCheckouts.businessId,
      pack: billingPackCheckouts.pack,
      priceId: billingPackCheckouts.priceId,
      status: billingPackCheckouts.status,
      providerRef: billingPackPrices.providerRef,
      retiredAt: billingPackPrices.retiredAt,
      packStatus: billingPackPlans.status,
      customerEmail: users.email,
      billingEmail: billingPackCheckouts.billingEmail,
      billingKey: billingAccounts.billingKey,
      customerId: billingAccounts.customerId,
      businessName: businesses.name,
      onboardingStage: businesses.onboardingStage,
    }).from(billingPackCheckouts)
      .innerJoin(users, eq(users.id, billingPackCheckouts.requestedByUserId))
      .innerJoin(businesses, eq(businesses.id, billingPackCheckouts.businessId))
      .innerJoin(billingPackPrices, eq(billingPackPrices.id, billingPackCheckouts.priceId))
      .innerJoin(billingPackPlans, eq(billingPackPlans.code, billingPackCheckouts.pack))
      .leftJoin(billingAccounts, eq(billingAccounts.businessId, billingPackCheckouts.businessId))
      .where(and(eq(billingPackCheckouts.id, input.checkoutId), eq(billingPackCheckouts.businessId, input.businessId)))
      .limit(1);
    if (!row) return null;
    const { providerRef, retiredAt, packStatus, billingKey, ...work } = row;
    return {
      ...work,
      priceRef: providerRef && retiredAt === null && packStatus === "active" ? providerRef : null,
      externalCustomerId: billingKey ?? `business:${input.businessId}`,
      customerId: work.customerId ?? null,
    };
  }, { accessMode: "read only" });
}

/** A checkout no run works on: still pending, or left processing by a run whose worker died. */
function unclaimedPackCheckout(input: { businessId: string; checkoutId: string }, now: Date): SQL | undefined {
  return and(
    eq(billingPackCheckouts.id, input.checkoutId),
    eq(billingPackCheckouts.businessId, input.businessId),
    or(eq(billingPackCheckouts.status, "pending"), and(eq(billingPackCheckouts.status, "processing"), lt(billingPackCheckouts.updatedAt, new Date(now.getTime() - BILLING_CHECKOUT_CLAIM_STALE_MS)))),
  );
}

/**
 * Claims a checkout for the job about to work on it, as
 * claimBillingCheckoutRequest claims a plan's: when no run works on it and it
 * is younger than BILLING_CHECKOUT_EXPIRES_MS. An older one expires instead.
 */
export async function claimPackCheckout(context: DomainContext, input: { businessId: string; checkoutId: string }): Promise<BillingCheckoutClaim> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const now = new Date();
    const rows = await tx.update(billingPackCheckouts).set({ status: "processing", updatedAt: now, error: null }).where(and(
      unclaimedPackCheckout(input, now),
      gte(billingPackCheckouts.createdAt, new Date(now.getTime() - BILLING_CHECKOUT_EXPIRES_MS)),
    )).returning({ id: billingPackCheckouts.id });
    if (rows.length > 0) return { claimed: true };
    if (await expirePackCheckout(tx, { ...input, now })) return { claimed: false, retryAt: null, expired: true };
    const [held] = await tx.select({ status: billingPackCheckouts.status, updatedAt: billingPackCheckouts.updatedAt }).from(billingPackCheckouts).where(and(eq(billingPackCheckouts.id, input.checkoutId), eq(billingPackCheckouts.businessId, input.businessId))).limit(1);
    if (held?.status !== "processing") return { claimed: false, retryAt: null };
    // Never sooner than a few seconds, so a worker whose clock runs behind doesn't spin.
    return { claimed: false, retryAt: new Date(Math.max(held.updatedAt.getTime() + BILLING_CHECKOUT_CLAIM_STALE_MS, now.getTime() + 5_000)) };
  });
}

/**
 * Expires a checkout older than BILLING_CHECKOUT_EXPIRES_MS that no run works
 * on, and tells its page. The job and the billing sweep both use it.
 */
export async function expirePackCheckout(tx: DatabaseTransaction, input: { businessId: string; checkoutId: string; now: Date }): Promise<boolean> {
  const rows = await tx.update(billingPackCheckouts).set({ status: "expired", error: PACK_CHECKOUT_WAITED, updatedAt: input.now }).where(and(
    unclaimedPackCheckout(input, input.now),
    lt(billingPackCheckouts.createdAt, new Date(input.now.getTime() - BILLING_CHECKOUT_EXPIRES_MS)),
  )).returning({ id: billingPackCheckouts.id });
  if (rows.length > 0) await publishPackCheckout(tx, { businessId: input.businessId, checkoutId: input.checkoutId, status: "expired" });
  return rows.length > 0;
}

/** Hands a claimed checkout back when its job will try again, so the page keeps waiting. */
export async function releasePackCheckout(context: DomainContext, input: { businessId: string; checkoutId: string }): Promise<boolean> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const rows = await tx.update(billingPackCheckouts).set({ status: "pending", updatedAt: new Date() }).where(and(eq(billingPackCheckouts.id, input.checkoutId), eq(billingPackCheckouts.businessId, input.businessId), eq(billingPackCheckouts.status, "processing"))).returning({ id: billingPackCheckouts.id });
    return rows.length > 0;
  });
}

/**
 * Records the provider's page: its checkout, its link and when it expires,
 * which is the provider's own, or PACK_CHECKOUT_PAGE_MS from now when it
 * gives none. One update, since the table wants a ready row's checkout and
 * link together.
 */
export async function markPackCheckoutReady(
  context: DomainContext,
  input: { businessId: string; checkoutId: string; providerCheckoutId: string; checkoutUrl: string; expiresAt: Date | null },
): Promise<boolean> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const now = new Date();
    const rows = await tx.update(billingPackCheckouts)
      .set({ status: "ready", checkoutId: input.providerCheckoutId, checkoutUrl: input.checkoutUrl, expiresAt: input.expiresAt ?? new Date(now.getTime() + PACK_CHECKOUT_PAGE_MS), error: null, updatedAt: now })
      .where(and(eq(billingPackCheckouts.id, input.checkoutId), eq(billingPackCheckouts.businessId, input.businessId), eq(billingPackCheckouts.status, "processing")))
      .returning({ id: billingPackCheckouts.id });
    if (rows.length > 0) await publishPackCheckout(tx, { businessId: input.businessId, checkoutId: input.checkoutId, status: "ready" });
    return rows.length > 0;
  });
}

export async function markPackCheckoutFailed(context: DomainContext, input: { businessId: string; checkoutId: string; error: string }): Promise<boolean> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const rows = await tx.update(billingPackCheckouts).set({ status: "failed", error: input.error, updatedAt: new Date() }).where(and(eq(billingPackCheckouts.id, input.checkoutId), eq(billingPackCheckouts.businessId, input.businessId), eq(billingPackCheckouts.status, "processing"))).returning({ id: billingPackCheckouts.id });
    if (rows.length > 0) await publishPackCheckout(tx, { businessId: input.businessId, checkoutId: input.checkoutId, status: "failed" });
    return rows.length > 0;
  });
}

/**
 * Marks the business's checkout paid, whatever its status, as billing.reconcile
 * does when the pack's payment arrives: a payment that settles late may land
 * after the row expired. checkoutId is the row's own ID, which the payment's
 * metadata carries. False when it was paid already or isn't the business's.
 */
export async function markPackCheckoutPaidInTransaction(tx: DatabaseTransaction, input: { businessId: string; checkoutId: string }): Promise<boolean> {
  if (!isUuid(input.checkoutId)) return false;
  const rows = await tx.update(billingPackCheckouts).set({ status: "paid", error: null, updatedAt: new Date() }).where(and(eq(billingPackCheckouts.id, input.checkoutId), eq(billingPackCheckouts.businessId, input.businessId), ne(billingPackCheckouts.status, "paid"))).returning({ id: billingPackCheckouts.id });
  if (rows.length > 0) await publishPackCheckout(tx, { businessId: input.businessId, checkoutId: input.checkoutId, status: "paid" });
  return rows.length > 0;
}

/** A pack checkout as the dashboard and the API show it. */
export type PackCheckoutView = {
  id: string;
  pack: string;
  status: PackCheckoutStatus;
  /** Where the business pays: only while the page is ready and hasn't expired. */
  checkoutUrl: string | null;
  /** Why it failed or expired; null otherwise. */
  error: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

/** The business's checkout, read in the caller's transaction; null when it has none by that ID. */
export async function readPackCheckoutInTransaction(tx: DatabaseTransaction, input: { businessId: string; checkoutId: string }, now = new Date()): Promise<PackCheckoutView | null> {
  if (!isUuid(input.checkoutId)) return null;
  const [row] = await tx.select({ id: billingPackCheckouts.id, pack: billingPackCheckouts.pack, status: billingPackCheckouts.status, checkoutUrl: billingPackCheckouts.checkoutUrl, error: billingPackCheckouts.error, expiresAt: billingPackCheckouts.expiresAt, createdAt: billingPackCheckouts.createdAt, updatedAt: billingPackCheckouts.updatedAt })
    .from(billingPackCheckouts).where(and(eq(billingPackCheckouts.id, input.checkoutId), eq(billingPackCheckouts.businessId, input.businessId))).limit(1);
  if (!row) return null;
  const status = isPackCheckoutStatus(row.status) ? row.status : "pending";
  return {
    id: row.id,
    pack: row.pack,
    status,
    checkoutUrl: status === "ready" && row.expiresAt.getTime() > now.getTime() ? row.checkoutUrl : null,
    error: status === "failed" || status === "expired" ? row.error : null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
