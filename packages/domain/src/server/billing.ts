import { randomUUID } from "node:crypto";

import { and, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { auditLogs, billingAccounts, billingCheckoutRequests, billingCodeRedemptions, billingTransactions, billingUsageEvents, businesses, enqueueOutbox, providerEvents, users, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { billingErrorCodes, DEFAULT_WEB_CALL_MAX_DURATION_MS, isPaidSubscription, isUuid, liveSubscriptionStates, MAX_WEB_CALL_MAX_DURATION_MS, type BillingPlanSlug } from "@lobbystack/shared";
import { getPostHogDistinctIdForBusinessSystem } from "@lobbystack/telemetry";

import type { DomainContext } from "./context";
import { recordAffiliateCommissionInTransaction } from "./affiliates";
import { recordProductEventInTransaction } from "./productEvents";
import { requireBusinessAdmin } from "../authz";
import { billingCodeCheckout, type BillingCodeRefusal } from "./billingCodes";
import { polarProductLinks, readBillingCatalogSnapshot } from "./billingPlans";
import { correctUsageInTransaction, enqueueUsageSyncInTransaction, getUsageStatusInTransaction, loadBillingContext, loadBusinessPlanLimits, readUsageStatusInTransaction, reserveUsageInTransaction, type UsageStatus } from "./usage";

export type BillingCheckoutTarget = "starter" | "pro";
export type BillingInterval = "monthly" | "annual";

export type WebVoiceBillingAllowance = {
  allowed: boolean;
  errorCode: typeof billingErrorCodes.voiceLimitReached | null;
  maxDurationMs: number;
  plan: BillingPlanSlug;
};

export function normalizeWebCallMaxDurationMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_WEB_CALL_MAX_DURATION_MS;
  return Math.min(Math.floor(value), MAX_WEB_CALL_MAX_DURATION_MS);
}

// A browser call gets the seconds a phone call could still reserve, up to the
// length asked for.
function webVoiceBillingAllowance(status: UsageStatus, maxDurationMs: number | undefined): WebVoiceBillingAllowance {
  const requested = normalizeWebCallMaxDurationMs(maxDurationMs);
  const remaining = Math.min(requested / 1_000, status.voiceSecondsLeft ?? Number.POSITIVE_INFINITY) * 1_000;
  return {
    allowed: remaining >= 1,
    errorCode: remaining < 1 ? billingErrorCodes.voiceLimitReached : null,
    maxDurationMs: Math.min(requested, Math.floor(remaining)),
    plan: status.plan,
  };
}

export async function getWebVoiceBillingAllowance(
  context: DomainContext,
  input: { businessId: string; maxDurationMs?: number },
): Promise<WebVoiceBillingAllowance> {
  // Decides whether to offer a call without writing; the call's reservation counts again.
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => webVoiceBillingAllowance(await readUsageStatusInTransaction(tx, { businessId: input.businessId }), input.maxDurationMs));
}

export async function reserveWebVoiceUsageInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; callId: string; maxDurationMs?: number },
): Promise<WebVoiceBillingAllowance> {
  const allowance = webVoiceBillingAllowance(await getUsageStatusInTransaction(tx, { businessId: input.businessId }), input.maxDurationMs);
  if (!allowance.allowed) return allowance;
  if (allowance.plan === "self_host") return allowance;
  const reservation = await reserveUsageInTransaction(tx, { businessId: input.businessId, usageKind: "voice_seconds", sourceKey: `voice:${input.callId}`, quantity: allowance.maxDurationMs / 1_000 });
  if (!reservation.allowed) {
    return { allowed: false, errorCode: billingErrorCodes.voiceLimitReached, maxDurationMs: 0, plan: allowance.plan };
  }
  return allowance;
}

export async function finalizeWebVoiceUsageInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; callId: string; durationSeconds: number },
): Promise<void> {
  const existing = (await tx.select({ id: billingUsageEvents.id }).from(billingUsageEvents).where(and(eq(billingUsageEvents.businessId, input.businessId), eq(billingUsageEvents.sourceKey, `voice:${input.callId}`))).limit(1))[0];
  if (!existing) return;
  const usageEventId = await correctUsageInTransaction(tx, { businessId: input.businessId, sourceKey: `voice:${input.callId}`, usageKind: "voice_seconds", quantity: input.durationSeconds });
  await enqueueUsageSyncInTransaction(tx, { businessId: input.businessId, usageEventId });
}

export type WidgetChatBillingAllowance = {
  allowed: boolean;
  errorCode: typeof billingErrorCodes.chatAiLimitReached | null;
  plan: BillingPlanSlug;
};

export async function getWidgetChatAllowance(
  context: DomainContext,
  input: { businessId: string },
): Promise<WidgetChatBillingAllowance> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    // Decides whether to offer the chat without writing; each chat's reservation counts again.
    const status = await readUsageStatusInTransaction(tx, { businessId: input.businessId });
    if (status.chatAiTokensIncluded === null || status.overagesBillable) {
      return { allowed: true, errorCode: null, plan: status.plan };
    }
    if (status.chatAiBlocked || Math.max(0, status.chatAiTokensIncluded - status.chatAiTokensUsed) < 1) {
      return { allowed: false, errorCode: billingErrorCodes.chatAiLimitReached, plan: status.plan };
    }
    return { allowed: true, errorCode: null, plan: status.plan };
  });
}

export async function reserveWidgetChatUsageInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; conversationId: string },
): Promise<WidgetChatBillingAllowance> {
  const { plan, limits } = await loadBusinessPlanLimits(tx, input.businessId);
  if (limits.chatAiTokensIncluded !== null) {
    const reservation = await reserveUsageInTransaction(tx, { businessId: input.businessId, usageKind: "chat_ai_tokens", sourceKey: `chat:${input.conversationId}`, quantity: 1 });
    if (!reservation.allowed) return { allowed: false, errorCode: billingErrorCodes.chatAiLimitReached, plan };
  }
  return { allowed: true, errorCode: null, plan };
}

/** What the dashboard tells someone whose promo code can't be used: every reason the code itself fails reads the same. */
const billingCodeRefusalErrors: Record<BillingCodeRefusal, { status: number; code: string; message: string }> = {
  invalid: { status: 400, code: "promo_invalid", message: "This code isn't valid." },
  current: { status: 409, code: "promo_current", message: "This business is already on that plan." },
  interval: { status: 409, code: "promo_interval", message: "That plan isn't sold with this billing interval." },
};

export function billingCodeRefusalError(refusal: BillingCodeRefusal): Error {
  const { message, ...rest } = billingCodeRefusalErrors[refusal];
  return Object.assign(new Error(message), rest);
}

/**
 * Queues a checkout from the dashboard. With a promo code it sells the plan
 * the code unlocks, at that plan's tier, instead of the target. checkPromoCode
 * runs once the person is known to manage the business, before the code is
 * looked up, so only its own admins spend the business's tries. checkLimit
 * runs only when a new request is made.
 */
export async function createBillingCheckoutRequest(
  context: DomainContext,
  input: { userId: string; businessId: string; target: BillingCheckoutTarget; billingInterval: BillingInterval; promoCode?: string | undefined; billingEmail?: string | undefined; checkPromoCode?: (() => Promise<void>) | undefined; checkLimit?: BillingCheckoutLimit | undefined },
): Promise<string> {
  const { checkPromoCode, ...request } = input;
  return await withBusinessTransaction(context.db, { ...request, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, request);
    if (request.promoCode === undefined) return (await createBillingCheckoutRequestInTransaction(tx, request)).id;
    await checkPromoCode?.();
    const sale = await billingCodeCheckout(tx, { businessId: request.businessId, code: request.promoCode, billingInterval: request.billingInterval });
    if ("refusal" in sale) throw billingCodeRefusalError(sale.refusal);
    return (await createBillingCheckoutRequestInTransaction(tx, { ...request, target: sale.offer.tier, promo: { planCode: sale.offer.plan, codeId: sale.offer.codeId } })).id;
  });
}

/** The plan other than the target's standard one that a checkout sells, and the promo code that unlocked it. */
export type BillingCheckoutPromo = { planCode: string; codeId: string };

/** A caller's limit on the checkouts it makes, by business and by the person a checkout is made out to; it throws to refuse. */
export type BillingCheckoutLimit = (subject: { businessId: string; userId: string }) => Promise<void>;

/**
 * Queues a Polar checkout for a plan in the name of the person asking. A
 * business without a Polar customer gets one with the billing email they
 * gave, else their own. A business on a managed plan is refused, because the
 * operator bills it and a Polar subscription would bill it twice, and so is a
 * standard plan the business can't buy (standardCheckoutAllowed). Callers
 * authorize first, and check a promo code with billingCodeCheckout.
 *
 * The person's request for the same plan, interval and billing email that is
 * still pending or processing comes back instead of a new one, so a second
 * click or a retry asks Polar for nothing; created says which. A business that
 * pays through Polar changes plan one request at a time, so two admins at once
 * can't both change its subscription: another open request is a 409
 * plan_change_pending. checkLimit runs only before a new request is made.
 */
export async function createBillingCheckoutRequestInTransaction(
  tx: DatabaseTransaction,
  input: { userId: string; businessId: string; target: BillingCheckoutTarget; billingInterval: BillingInterval; promo?: BillingCheckoutPromo | undefined; billingEmail?: string | undefined; checkLimit?: BillingCheckoutLimit | undefined },
): Promise<{ id: string; created: boolean }> {
  // The lock a managed plan takes, so a checkout and a managed plan can't both start at once.
  await lockBillingAccount(tx, input.businessId);
  const [account] = await tx.select({ source: billingAccounts.source, subscriptionState: billingAccounts.subscriptionState, subscriptionId: billingAccounts.subscriptionId, plan: billingAccounts.plan }).from(billingAccounts).where(eq(billingAccounts.businessId, input.businessId)).limit(1);
  if (isManagedBillingAccount(account)) throw Object.assign(new Error("This business is on a managed plan, billed directly by the operator."), { status: 409 });
  if (!input.promo && !standardCheckoutAllowed((await loadBillingContext(tx, input.businessId)).plan, input.target)) throw Object.assign(new Error(PAID_PLAN_CHECKOUT_REFUSAL), { status: 409 });
  // Under the lock, so two clicks at once make one request. One older than its 15 minutes fails rather than runs.
  const [open] = await tx.select({ id: billingCheckoutRequests.id }).from(billingCheckoutRequests).where(and(
    eq(billingCheckoutRequests.businessId, input.businessId),
    eq(billingCheckoutRequests.requestedByUserId, input.userId),
    inArray(billingCheckoutRequests.status, ["pending", "processing"]),
    gte(billingCheckoutRequests.createdAt, new Date(Date.now() - BILLING_CHECKOUT_EXPIRES_MS)),
    eq(billingCheckoutRequests.target, input.target),
    eq(billingCheckoutRequests.billingInterval, input.billingInterval),
    input.promo ? and(eq(billingCheckoutRequests.planCode, input.promo.planCode), eq(billingCheckoutRequests.codeId, input.promo.codeId)) : isNull(billingCheckoutRequests.planCode),
    input.billingEmail ? eq(billingCheckoutRequests.billingEmail, input.billingEmail) : isNull(billingCheckoutRequests.billingEmail),
  )).orderBy(desc(billingCheckoutRequests.createdAt)).limit(1);
  if (open) return { id: open.id, created: false };
  // A plan change, as the checkout job reads it: Polar has no check for a change to the product it is already on.
  if (paysThroughPolar(account)) {
    const [other] = await tx.select({ id: billingCheckoutRequests.id }).from(billingCheckoutRequests).where(and(
      eq(billingCheckoutRequests.businessId, input.businessId),
      inArray(billingCheckoutRequests.status, ["pending", "processing"]),
      gte(billingCheckoutRequests.createdAt, new Date(Date.now() - BILLING_CHECKOUT_EXPIRES_MS)),
    )).limit(1);
    if (other) throw Object.assign(new Error("Another plan change for this business is in progress. Try again in a minute."), { status: 409, code: "plan_change_pending" });
  }
  await input.checkLimit?.({ businessId: input.businessId, userId: input.userId });
  await tx.insert(billingAccounts).values({ businessId: input.businessId, billingKey: `business:${input.businessId}` }).onConflictDoNothing({ target: billingAccounts.businessId });
  const [request] = await tx.insert(billingCheckoutRequests).values({
    businessId: input.businessId,
    requestedByUserId: input.userId,
    target: input.target,
    billingInterval: input.billingInterval,
    status: "pending",
    ...(input.promo ? { planCode: input.promo.planCode, codeId: input.promo.codeId } : {}),
    ...(input.billingEmail ? { billingEmail: input.billingEmail } : {}),
  }).returning({ id: billingCheckoutRequests.id });
  if (!request) throw new Error("Billing checkout request could not be created.");
  await enqueueOutbox(tx, {
    topic: "billing.createCheckout",
    businessId: input.businessId,
    aggregateType: "billing_checkout_request",
    aggregateId: request.id,
    dedupeKey: `billing-checkout:${request.id}`,
    payload: { requestId: request.id },
  });
  return { id: request.id, created: true };
}

/**
 * Whether a business can buy a plan without a promo code: any plan while it is
 * free, and Pro from Starter, as the plan screens offer. Other changes to a
 * paid plan happen in Polar's billing portal.
 */
export function standardCheckoutAllowed(current: BillingPlanSlug, target: BillingCheckoutTarget): boolean {
  return current === "free_cloud" || (current === "starter" && target === "pro");
}

export const PAID_PLAN_CHECKOUT_REFUSAL = "This business already pays for a plan. Change it in the billing portal.";

/**
 * A billing account whose plan the LobbyStack operator runs outside Polar and
 * bills directly. Polar events don't change it unless the business starts a
 * live Polar subscription, which then takes over.
 */
export const MANAGED_BILLING_SOURCE = "managed";

export function isLiveSubscriptionState(state: string | null | undefined): boolean {
  return (liveSubscriptionStates as readonly string[]).includes(state ?? "");
}

/** Whether a business pays for Starter or Pro with a live Polar subscription, which a checkout request then changes instead of starting another. */
function paysThroughPolar(account: { source: string | null; subscriptionState: string | null; subscriptionId: string | null; plan: string | null } | undefined): account is { source: string | null; subscriptionState: string; subscriptionId: string; plan: "starter" | "pro" } {
  return Boolean(account?.subscriptionId) && account?.source !== MANAGED_BILLING_SOURCE && isLiveSubscriptionState(account?.subscriptionState) && (account?.plan === "starter" || account?.plan === "pro");
}

/** Whether a billing account is on a managed plan now. An ended managed plan keeps its source, for the finance export, but isn't live. */
export function isManagedBillingAccount(account: { source?: string | null; subscriptionState: string | null } | null | undefined): boolean {
  return account?.source === MANAGED_BILLING_SOURCE && isLiveSubscriptionState(account.subscriptionState);
}

/** Billing account changes take this lock, the same one Polar reconciliation takes, so the two can't interleave. */
export async function lockBillingAccount(tx: DatabaseTransaction, businessId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing-reconcile:${businessId}`}, 0))`);
}

/**
 * Puts a business on the enterprise plan outside Polar, which unlocks what a
 * paid plan unlocks while the operator bills the business directly. A business
 * with a live Polar subscription, for any product, is refused, so no one pays
 * twice. A spending cap left from an earlier Starter or Pro plan is cleared,
 * because on enterprise a cap leaves calls nothing to reserve. Callers check
 * that an operator asked.
 */
export async function setManagedPlanInTransaction(tx: DatabaseTransaction, input: { businessId: string }): Promise<"set" | "unchanged" | "paid_through_polar"> {
  await lockBillingAccount(tx, input.businessId);
  const [account] = await tx.select({ source: billingAccounts.source, plan: billingAccounts.plan, subscriptionState: billingAccounts.subscriptionState, overageSpendingCapCents: billingAccounts.overageSpendingCapCents }).from(billingAccounts).where(eq(billingAccounts.businessId, input.businessId)).limit(1);
  if (isManagedBillingAccount(account) && account?.plan === "enterprise" && account.overageSpendingCapCents === null) return "unchanged";
  if (account && account.source !== MANAGED_BILLING_SOURCE && isLiveSubscriptionState(account.subscriptionState)) return "paid_through_polar";
  const now = new Date();
  // A promo plan from an earlier subscription ends with it.
  const managed = { source: MANAGED_BILLING_SOURCE, plan: "enterprise", planCode: null, planEnds: null, codeId: null, subscriptionState: "active", billingInterval: null, subscriptionId: null, currentPeriodStart: now, currentPeriodEnd: null, overageSpendingCapCents: null };
  await tx.insert(billingAccounts).values({ businessId: input.businessId, billingKey: `business:${input.businessId}`, ...managed }).onConflictDoUpdate({ target: billingAccounts.businessId, set: { ...managed, updatedAt: now } });
  // Checkouts Polar hasn't made a page for yet would sell a plan the operator now bills, so they stop here.
  await tx.update(billingCheckoutRequests).set({ status: "canceled", error: "The business moved to a managed plan.", updatedAt: now }).where(and(eq(billingCheckoutRequests.businessId, input.businessId), inArray(billingCheckoutRequests.status, ["pending", "processing", "error"])));
  await enqueueOutbox(tx, { topic: "realtime.publish", businessId: input.businessId, aggregateType: "billing_account", aggregateId: input.businessId, dedupeKey: `billing:${input.businessId}:managed:${now.getTime()}`, payload: { type: "billing.updated", entityId: input.businessId } });
  return "set";
}

/**
 * Ends a business's managed plan, which puts it on the free plan. The account
 * keeps its managed source and enterprise plan, now canceled, so the finance
 * export still shows the managed period and when it ended. False when the
 * business has no managed plan. Callers check that an operator asked.
 */
export async function endManagedPlanInTransaction(tx: DatabaseTransaction, input: { businessId: string }): Promise<boolean> {
  await lockBillingAccount(tx, input.businessId);
  const now = new Date();
  const ended = await tx.update(billingAccounts)
    .set({ subscriptionState: "canceled", currentPeriodEnd: now, updatedAt: now })
    .where(and(eq(billingAccounts.businessId, input.businessId), eq(billingAccounts.source, MANAGED_BILLING_SOURCE), inArray(billingAccounts.subscriptionState, [...liveSubscriptionStates])))
    .returning({ id: billingAccounts.id });
  if (!ended.length) return false;
  await enqueueOutbox(tx, { topic: "realtime.publish", businessId: input.businessId, aggregateType: "billing_account", aggregateId: input.businessId, dedupeKey: `billing:${input.businessId}:managed-ended:${now.getTime()}`, payload: { type: "billing.updated", entityId: input.businessId } });
  return true;
}

export async function loadBillingCheckoutRequest(
  context: DomainContext,
  input: { businessId: string; requestId: string },
): Promise<{
  id: string;
  businessId: string;
  target: BillingCheckoutTarget;
  billingInterval: BillingInterval;
  status: string;
  checkoutId: string | null;
  checkoutUrl: string | null;
  error: string | null;
  /** The email of the person who asked, which Polar's customer gets unless they gave a billing email. */
  customerEmail: string;
  /** The email the person gave for this business's billing, when their own already belongs to another Polar customer. */
  billingEmail: string | null;
  /** The account's billing key: the external ID of the business's Polar customer. */
  externalCustomerId: string;
  businessName: string;
  onboardingStage: string;
  /** The plan other than the target's standard one it sells, such as a promo plan; null for the standard plan. */
  planCode: string | null;
  /** The live Polar subscription the business already pays with, which a plan change moves instead of starting a second one. planCode is the plan it is on when that isn't a standard one. */
  subscription: { id: string; plan: "starter" | "pro"; billingInterval: BillingInterval | null; planCode: string | null } | null;
} | null> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const row = (await tx.select({
      id: billingCheckoutRequests.id,
      businessId: billingCheckoutRequests.businessId,
      target: billingCheckoutRequests.target,
      billingInterval: billingCheckoutRequests.billingInterval,
      status: billingCheckoutRequests.status,
      checkoutId: billingCheckoutRequests.checkoutId,
      checkoutUrl: billingCheckoutRequests.checkoutUrl,
      error: billingCheckoutRequests.error,
      planCode: billingCheckoutRequests.planCode,
      customerEmail: users.email,
      billingEmail: billingCheckoutRequests.billingEmail,
      billingKey: billingAccounts.billingKey,
      subscriptionId: billingAccounts.subscriptionId,
      plan: billingAccounts.plan,
      currentPlanCode: billingAccounts.planCode,
      currentInterval: billingAccounts.billingInterval,
      subscriptionState: billingAccounts.subscriptionState,
      source: billingAccounts.source,
      businessName: businesses.name,
      onboardingStage: businesses.onboardingStage,
    }).from(billingCheckoutRequests)
      .innerJoin(users, eq(users.id, billingCheckoutRequests.requestedByUserId))
      .leftJoin(billingAccounts, eq(billingAccounts.businessId, billingCheckoutRequests.businessId))
      .innerJoin(businesses, eq(businesses.id, billingCheckoutRequests.businessId))
      .where(and(eq(billingCheckoutRequests.id, input.requestId), eq(billingCheckoutRequests.businessId, input.businessId)))
      .limit(1))[0];
    if (!row || !isBillingCheckoutTarget(row.target) || !isBillingInterval(row.billingInterval)) return null;
    const { billingKey, subscriptionId, plan, currentPlanCode, currentInterval, subscriptionState, source, ...request } = row;
    const account = { subscriptionId, plan, subscriptionState, source };
    return {
      ...request,
      target: row.target,
      billingInterval: row.billingInterval,
      externalCustomerId: billingKey ?? `business:${input.businessId}`,
      subscription: paysThroughPolar(account) ? { id: account.subscriptionId, plan: account.plan, billingInterval: currentInterval && isBillingInterval(currentInterval) ? currentInterval : null, planCode: currentPlanCode } : null,
    };
  });
}

/**
 * How long a checkout request stays processing before another run of its job
 * may take it over. A job asks Polar at most a few times, each within 15
 * seconds, so only a job whose worker died holds a request this long.
 */
export const BILLING_CHECKOUT_CLAIM_STALE_MS = 5 * 60_000;

/**
 * How long a checkout request can wait for its job. By then nobody waits on
 * its page, and a plan change would surprise whoever asked for it, so the
 * request fails instead, and they can ask again.
 */
export const BILLING_CHECKOUT_EXPIRES_MS = 15 * 60_000;

/**
 * A claimed request, or one this run can't work on: retryAt says when the
 * claim of the run that holds it goes stale, and is null when the request is
 * done; expired says this claim failed it for waiting too long.
 */
export type BillingCheckoutClaim = { claimed: true } | { claimed: false; retryAt: Date | null; expired?: true };

/** A request no run works on: still pending, or left processing by a run whose worker died. */
function unclaimedCheckoutRequest(input: { businessId: string; requestId: string }, now: Date): SQL | undefined {
  return and(
    eq(billingCheckoutRequests.id, input.requestId),
    eq(billingCheckoutRequests.businessId, input.businessId),
    or(eq(billingCheckoutRequests.status, "pending"), and(eq(billingCheckoutRequests.status, "processing"), lt(billingCheckoutRequests.updatedAt, new Date(now.getTime() - BILLING_CHECKOUT_CLAIM_STALE_MS)))),
  );
}

/**
 * Claims a request for the job about to work on it, when no run works on it
 * and it is younger than BILLING_CHECKOUT_EXPIRES_MS; an older one fails. A
 * request that failed stays failed: the person asks again, rather than have a
 * plan change the page said failed go through later.
 */
export async function claimBillingCheckoutRequest(
  context: DomainContext,
  input: { businessId: string; requestId: string },
): Promise<BillingCheckoutClaim> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const now = new Date();
    const rows = await tx.update(billingCheckoutRequests).set({ status: "processing", updatedAt: now, error: null }).where(and(
      unclaimedCheckoutRequest(input, now),
      gte(billingCheckoutRequests.createdAt, new Date(now.getTime() - BILLING_CHECKOUT_EXPIRES_MS)),
    )).returning({ id: billingCheckoutRequests.id });
    if (rows.length > 0) return { claimed: true };
    if (await expireBillingCheckoutRequest(tx, { ...input, now })) return { claimed: false, retryAt: null, expired: true };
    const [held] = await tx.select({ status: billingCheckoutRequests.status, updatedAt: billingCheckoutRequests.updatedAt }).from(billingCheckoutRequests).where(and(eq(billingCheckoutRequests.id, input.requestId), eq(billingCheckoutRequests.businessId, input.businessId))).limit(1);
    if (held?.status !== "processing") return { claimed: false, retryAt: null };
    // Never sooner than a few seconds, so a worker whose clock runs behind doesn't spin.
    return { claimed: false, retryAt: new Date(Math.max(held.updatedAt.getTime() + BILLING_CHECKOUT_CLAIM_STALE_MS, now.getTime() + 5_000)) };
  });
}

/**
 * Fails a request older than BILLING_CHECKOUT_EXPIRES_MS that no run works
 * on, and tells its page. The checkout job and the billing sweep both use it.
 */
export async function expireBillingCheckoutRequest(
  tx: DatabaseTransaction,
  input: { businessId: string; requestId: string; now: Date },
): Promise<boolean> {
  const rows = await tx.update(billingCheckoutRequests).set({ status: "error", error: "This request waited too long to run.", updatedAt: input.now }).where(and(
    unclaimedCheckoutRequest(input, input.now),
    lt(billingCheckoutRequests.createdAt, new Date(input.now.getTime() - BILLING_CHECKOUT_EXPIRES_MS)),
  )).returning({ id: billingCheckoutRequests.id });
  if (rows.length > 0) {
    await enqueueOutbox(tx, { topic: "realtime.publish", businessId: input.businessId, aggregateType: "billing_checkout_request", aggregateId: input.requestId, dedupeKey: `billing-checkout:${input.requestId}:error`, payload: { type: "billing.updated", entityId: input.requestId } });
  }
  return rows.length > 0;
}

/**
 * Hands a claimed request back when its job will try again, so the page keeps
 * waiting instead of showing a failure that the next attempt may undo.
 */
export async function releaseBillingCheckoutRequest(
  context: DomainContext,
  input: { businessId: string; requestId: string },
): Promise<boolean> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const rows = await tx.update(billingCheckoutRequests).set({ status: "pending", updatedAt: new Date() }).where(and(eq(billingCheckoutRequests.id, input.requestId), eq(billingCheckoutRequests.businessId, input.businessId), eq(billingCheckoutRequests.status, "processing"))).returning({ id: billingCheckoutRequests.id });
    return rows.length > 0;
  });
}

/**
 * How long one change to a business's Polar subscription can hold it: a read
 * and a change of 15 seconds each, and the database work around them.
 */
export const BILLING_SUBSCRIPTION_CLAIM_MS = 2 * 60_000;

/**
 * Claims a business's Polar subscription for one change: a plan change, a
 * promo plan's ending or a discount's removal. Each reads the subscription
 * from Polar and then changes it, so two at once would each change it from
 * what the other replaced. Returns the claim, or when to look again while
 * another change holds it. A claim its run never hands back runs out after
 * BILLING_SUBSCRIPTION_CLAIM_MS.
 */
export async function claimBillingSubscription(context: DomainContext, input: { businessId: string }): Promise<{ claimId: string } | { retryAt: Date }> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const claimId = randomUUID();
    const now = new Date();
    const rows = await tx.update(billingAccounts).set({ subscriptionClaim: claimId, subscriptionClaimedUntil: new Date(now.getTime() + BILLING_SUBSCRIPTION_CLAIM_MS) })
      .where(and(eq(billingAccounts.businessId, input.businessId), or(isNull(billingAccounts.subscriptionClaimedUntil), lt(billingAccounts.subscriptionClaimedUntil, now))))
      .returning({ businessId: billingAccounts.businessId });
    if (rows.length > 0) return { claimId };
    const [held] = await tx.select({ until: billingAccounts.subscriptionClaimedUntil }).from(billingAccounts).where(eq(billingAccounts.businessId, input.businessId)).limit(1);
    // A business with no account has no subscription for another change to hold.
    if (!held?.until) return { claimId };
    // A change takes seconds, so look again soon, and never later than the claim runs out.
    return { retryAt: new Date(Math.max(now.getTime() + 1_000, Math.min(held.until.getTime(), now.getTime() + 15_000))) };
  });
}

/** Hands the subscription back once the change is done, if the claim is still this run's. */
export async function releaseBillingSubscription(context: DomainContext, input: { businessId: string; claimId: string }): Promise<void> {
  await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    await tx.update(billingAccounts).set({ subscriptionClaim: null, subscriptionClaimedUntil: null }).where(and(eq(billingAccounts.businessId, input.businessId), eq(billingAccounts.subscriptionClaim, input.claimId)));
  });
}

export async function markBillingCheckoutCreated(
  context: DomainContext,
  input: { businessId: string; requestId: string; checkoutId: string; checkoutUrl: string },
): Promise<boolean> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const rows = await tx.update(billingCheckoutRequests).set({ status: "ready", checkoutId: input.checkoutId, checkoutUrl: input.checkoutUrl, error: null, updatedAt: new Date() }).where(and(eq(billingCheckoutRequests.id, input.requestId), eq(billingCheckoutRequests.businessId, input.businessId), eq(billingCheckoutRequests.status, "processing"))).returning({ id: billingCheckoutRequests.id });
    if (rows.length > 0) {
      await enqueueOutbox(tx, { topic: "realtime.publish", businessId: input.businessId, aggregateType: "billing_checkout_request", aggregateId: input.requestId, dedupeKey: `billing-checkout:${input.requestId}:ready`, payload: { type: "billing.updated", entityId: input.requestId } });
    }
    return rows.length > 0;
  });
}

/**
 * A request a paying business made, done by moving its Polar subscription to
 * the plan instead of opening a checkout. The plan itself changes when Polar's
 * webhook arrives.
 */
export async function markBillingPlanChanged(
  context: DomainContext,
  input: { businessId: string; requestId: string },
): Promise<boolean> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const rows = await tx.update(billingCheckoutRequests).set({ status: "changed", error: null, updatedAt: new Date() }).where(and(eq(billingCheckoutRequests.id, input.requestId), eq(billingCheckoutRequests.businessId, input.businessId), eq(billingCheckoutRequests.status, "processing"))).returning({ id: billingCheckoutRequests.id });
    if (rows.length > 0) {
      await enqueueOutbox(tx, { topic: "realtime.publish", businessId: input.businessId, aggregateType: "billing_checkout_request", aggregateId: input.requestId, dedupeKey: `billing-checkout:${input.requestId}:changed`, payload: { type: "billing.updated", entityId: input.requestId } });
    }
    return rows.length > 0;
  });
}

export async function markBillingCheckoutFailed(
  context: DomainContext,
  input: { businessId: string; requestId: string; error: string },
): Promise<boolean> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const rows = await tx.update(billingCheckoutRequests).set({ status: "error", error: input.error, updatedAt: new Date() }).where(and(eq(billingCheckoutRequests.id, input.requestId), eq(billingCheckoutRequests.businessId, input.businessId), eq(billingCheckoutRequests.status, "processing"))).returning({ id: billingCheckoutRequests.id });
    if (rows.length > 0) {
      await enqueueOutbox(tx, { topic: "realtime.publish", businessId: input.businessId, aggregateType: "billing_checkout_request", aggregateId: input.requestId, dedupeKey: `billing-checkout:${input.requestId}:error`, payload: { type: "billing.updated", entityId: input.requestId } });
    }
    return rows.length > 0;
  });
}

function isBillingCheckoutTarget(value: string): value is BillingCheckoutTarget {
  return value === "starter" || value === "pro";
}

function isBillingInterval(value: string): value is BillingInterval {
  return value === "monthly" || value === "annual";
}

export async function getBillingUsageStatus(
  context: DomainContext,
  input: { businessId: string; periodKey?: string },
) {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => await getUsageStatusInTransaction(tx, input));
}

export async function setOverageSpendingCap(
  context: DomainContext,
  input: { userId: string; businessId: string; capCents: number | null },
): Promise<{ overageSpendingCapCents: number | null; overageSpendCents: number; overageSpendingCapReached: boolean }> {
  return await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    return await setOverageSpendingCapInTransaction(tx, input);
  });
}

/** Sets or clears the cap on a Starter or Pro plan's overage spend this month. Callers authorize first. */
export async function setOverageSpendingCapInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; capCents: number | null },
): Promise<{ overageSpendingCapCents: number | null; overageSpendCents: number; overageSpendingCapReached: boolean }> {
  if (input.capCents !== null && (!Number.isSafeInteger(input.capCents) || input.capCents < 0)) {
    throw new Error("Overage spending cap must be a non-negative whole number of cents.");
  }
  const current = await getUsageStatusInTransaction(tx, { businessId: input.businessId });
  if (current.plan !== "starter" && current.plan !== "pro") {
    throw new Error("Overage spending caps are available on Starter and Pro plans.");
  }
  const rows = await tx.update(billingAccounts)
    .set({ overageSpendingCapCents: input.capCents, updatedAt: new Date() })
    .where(eq(billingAccounts.businessId, input.businessId))
    .returning({ id: billingAccounts.id });
  if (!rows[0]) throw new Error("A billing account is required to set an overage spending cap.");
  const status = await getUsageStatusInTransaction(tx, { businessId: input.businessId });
  return { overageSpendingCapCents: input.capCents, overageSpendCents: status.overageSpendCents, overageSpendingCapReached: status.overageSpendingCapReached };
}

export async function reserveAlertSmsUsage(
  context: DomainContext,
  input: { businessId: string; sourceKey: string; estimatedSegments: number; recordedAt?: Date },
): Promise<Awaited<ReturnType<typeof reserveUsageInTransaction>>> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => await reserveUsageInTransaction(tx, { businessId: input.businessId, usageKind: "alert_sms_segments", sourceKey: input.sourceKey, quantity: Math.max(1, Math.trunc(input.estimatedSegments)), recordedAt: input.recordedAt }));
}

export async function correctAlertSmsUsage(
  context: DomainContext,
  input: { businessId: string; sourceKey: string; segments: number; recordedAt?: Date },
): Promise<string> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => await correctUsageInTransaction(tx, { businessId: input.businessId, sourceKey: input.sourceKey, usageKind: "alert_sms_segments", quantity: Math.max(0, Math.trunc(input.segments)), recordedAt: input.recordedAt }));
}

export async function reserveOutboundCallAttempt(
  context: DomainContext,
  input: { businessId: string; sourceKey: string; recordedAt?: Date },
): Promise<Awaited<ReturnType<typeof reserveUsageInTransaction>>> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const reservation = await reserveUsageInTransaction(tx, { businessId: input.businessId, usageKind: "outbound_call_attempts", sourceKey: input.sourceKey, quantity: 1, recordedAt: input.recordedAt });
    if (reservation.allowed && reservation.usageEventId) await enqueueUsageSyncInTransaction(tx, { businessId: input.businessId, usageEventId: reservation.usageEventId });
    return reservation;
  });
}

export async function enqueueBillingUsageSync(context: DomainContext, input: { businessId: string; usageEventId: string }): Promise<void> {
  await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => await enqueueUsageSyncInTransaction(tx, input));
}

export async function loadBillingUsageEvent(
  context: DomainContext,
  input: { businessId: string; usageEventId: string },
): Promise<{
  id: string;
  sourceKey: string;
  isFinal: boolean;
  plan: string | null;
  businessId: string;
  usageKind: string;
  quantity: number;
  billableQuantity: number | null;
  billingIntervalAtRecordTime: string | null;
  createdAt: Date;
  syncStatus: string;
  billingKey: string;
  customerId: string | null;
} | null> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const row = (await tx.select({
      id: billingUsageEvents.id,
      sourceKey: billingUsageEvents.sourceKey,
      isFinal: billingUsageEvents.isFinal,
      plan: sql<string | null>`coalesce(${billingUsageEvents.planAtRecordTime}, ${billingAccounts.plan})`,
      businessId: billingUsageEvents.businessId,
      usageKind: billingUsageEvents.usageKind,
      quantity: billingUsageEvents.quantity,
      billableQuantity: billingUsageEvents.billableQuantity,
      billingIntervalAtRecordTime: billingUsageEvents.billingIntervalAtRecordTime,
      createdAt: billingUsageEvents.createdAt,
      syncStatus: billingUsageEvents.syncStatus,
      billingKey: billingAccounts.billingKey,
      customerId: billingAccounts.customerId,
    })
      .from(billingUsageEvents)
      .innerJoin(billingAccounts, eq(billingAccounts.businessId, billingUsageEvents.businessId))
      .where(and(
        eq(billingUsageEvents.id, input.usageEventId),
        eq(billingUsageEvents.businessId, input.businessId),
      ))
      .limit(1))[0];
    return row ?? null;
  });
}

/** A difference this small is rounding, not usage. */
const SAME_QUANTITY = 1e-9;

/** The Polar event a usage row sends next: its first under the source key, as before migration 0116, and each later one numbered. */
export function billingUsageEventExternalId(sourceKey: string, seq: number): string {
  return seq === 0 ? sourceKey : `${sourceKey}:${seq}`;
}

/**
 * Claims the next Polar event for a pending usage row: its billable quantity
 * the first time, and after a correction the difference from what Polar has,
 * as Polar keeps one event per ID and drops a second under the same one. A
 * claimed event the worker never confirmed goes out again as it was, which
 * Polar keeps once. Null when nothing is left to send, as when a correction
 * came back to what Polar has, which the row then records as synced.
 */
export async function claimBillingUsageSync(
  context: DomainContext,
  input: { businessId: string; usageEventId: string },
): Promise<{ externalId: string; quantity: number; seq: number } | null> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const where = and(eq(billingUsageEvents.id, input.usageEventId), eq(billingUsageEvents.businessId, input.businessId));
    const [row] = await tx.select({ sourceKey: billingUsageEvents.sourceKey, syncStatus: billingUsageEvents.syncStatus, quantity: billingUsageEvents.quantity, billableQuantity: billingUsageEvents.billableQuantity, syncedQuantity: billingUsageEvents.syncedQuantity, syncSeq: billingUsageEvents.syncSeq, sendingQuantity: billingUsageEvents.sendingQuantity })
      .from(billingUsageEvents).where(where).limit(1).for("update");
    if (!row || row.syncStatus !== "pending") return null;
    const externalId = billingUsageEventExternalId(row.sourceKey, row.syncSeq);
    if (row.sendingQuantity !== null) return { externalId, quantity: row.sendingQuantity, seq: row.syncSeq };
    const quantity = (row.billableQuantity ?? row.quantity) - (row.syncedQuantity ?? 0);
    if (row.syncSeq > 0 && Math.abs(quantity) < SAME_QUANTITY) {
      await tx.update(billingUsageEvents).set({ syncStatus: "synced", updatedAt: new Date() }).where(where);
      return null;
    }
    await tx.update(billingUsageEvents).set({ sendingQuantity: quantity }).where(where);
    return { externalId, quantity, seq: row.syncSeq };
  });
}

/**
 * Records that Polar took a claimed event: Polar has its quantity on top of
 * what it had, and the next event takes the next number. A row that a
 * correction changed meanwhile stays pending, with its next sync queued.
 * False when another run confirmed the event first.
 */
export async function confirmBillingUsageSync(
  context: DomainContext,
  input: { businessId: string; usageEventId: string; seq: number },
): Promise<boolean> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const where = and(eq(billingUsageEvents.id, input.usageEventId), eq(billingUsageEvents.businessId, input.businessId));
    const [row] = await tx.select({ syncStatus: billingUsageEvents.syncStatus, quantity: billingUsageEvents.quantity, billableQuantity: billingUsageEvents.billableQuantity, syncedQuantity: billingUsageEvents.syncedQuantity, syncSeq: billingUsageEvents.syncSeq, sendingQuantity: billingUsageEvents.sendingQuantity })
      .from(billingUsageEvents).where(where).limit(1).for("update");
    if (!row || row.syncSeq !== input.seq || row.sendingQuantity === null) return false;
    const syncedQuantity = (row.syncedQuantity ?? 0) + row.sendingQuantity;
    const done = Math.abs((row.billableQuantity ?? row.quantity) - syncedQuantity) < SAME_QUANTITY;
    await tx.update(billingUsageEvents).set({ syncedQuantity, syncSeq: input.seq + 1, sendingQuantity: null, ...(done && row.syncStatus === "pending" ? { syncStatus: "synced", updatedAt: new Date() } : {}) }).where(where);
    if (!done) await enqueueUsageSyncInTransaction(tx, input);
    return true;
  });
}

function recordObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stringField(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function numberField(source: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * What Polar refunded on an order. The order total includes tax, and Polar
 * reports refunded tax apart from the refunded amount.
 */
export function orderRefundedCents(order: Record<string, unknown>, payload: Record<string, unknown>): number {
  return (numberField(order, "refundedAmount", "refunded_amount") ?? numberField(payload, "refundedAmount", "refunded_amount") ?? 0)
    + (numberField(order, "refundedTaxAmount", "refunded_tax_amount") ?? numberField(payload, "refundedTaxAmount", "refunded_tax_amount") ?? 0);
}

/**
 * How far an order has gone: draft, pending, paid, then partly and fully
 * refunded. Polar moves an order only forward, but for a void one, which it
 * can put back to pending, so it ranks with pending. A status not listed has
 * no rank.
 */
function orderStatusRank(status: SQLWrapper): SQL {
  return sql`array_position(array['draft', 'pending', 'paid', 'partially_refunded', 'refunded']::text[], (case when ${status} = 'void' then 'pending' else ${status} end)::text)`;
}

function dateField(source: Record<string, unknown>, ...keys: string[]): Date | undefined {
  const value = stringField(source, ...keys);
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}

export type SubscriptionStart = { plan: string; billingInterval: string | null; previousPlan: string | null };

/**
 * A subscription starts on the edge into a paid, live plan. Later webhooks for
 * the same subscription describe an account that was already paying, so they
 * must not report a second start.
 */
export function detectSubscriptionStart(
  previous: { plan: string | null; subscriptionState: string | null } | undefined,
  next: { plan: string | null; subscriptionState: string | null; billingInterval: string | null },
): SubscriptionStart | null {
  if (!isPaidSubscription(next.plan, next.subscriptionState)) return null;
  if (isPaidSubscription(previous?.plan ?? null, previous?.subscriptionState ?? null)) return null;
  return { plan: next.plan!, billingInterval: next.billingInterval, previousPlan: previous?.plan ?? null };
}

/** The same day so many months on, or the month's last day when it is shorter, as Polar counts: January 31 and a month is February 28. */
function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return next;
}

/**
 * The account's promo columns once Polar names the product a business pays
 * for. A product of a plan other than its tier's standard one, such as a
 * promo plan, names that plan once its subscription is live; the code is the
 * one the paid checkout or plan change carried, else the one the business's
 * newest checkout for that plan carried. Moving onto the plan, from another
 * plan or with a new subscription, fixes the plan's terms and starts a
 * time-limited plan's months, and the first time the business uses that
 * code, counts the use and records it in the audit log; a plan whose ending
 * is keep never ends. A live standard product clears the promo columns, and
 * moving onto one from a promo plan records how the plan ended. A
 * subscription that ends leaves them as they are: nothing reads them once it
 * isn't live.
 */
async function promoPlanFields(
  tx: DatabaseTransaction,
  input: {
    businessId: string;
    plan: string;
    planCode: string | undefined;
    existing: { planCode: string | null; subscriptionId: string | null; subscriptionState: string | null; currentPeriodStart: Date | null; endSetAt: Date | null } | undefined;
    live: boolean;
    subscriptionId: string | null | undefined;
    periodStart: Date | undefined;
    periodEnd: Date | undefined;
    /** The checkout request the subscription's lobbystack_checkout metadata names. */
    checkoutRequestId: string | undefined;
  },
): Promise<{ planCode?: string | null; codeId?: string | null; planEnds?: Date | null; endWith?: string | null; endNoticeAt?: Date | null; endSetAt?: Date | null }> {
  const noEnding = { endWith: null, endNoticeAt: null, endSetAt: null };
  // Only a live subscription moves the account, so a late event about an older one changes nothing here.
  if (!input.planCode || input.planCode === input.plan) {
    if (!input.live) return {};
    const left = input.existing?.planCode;
    if (left && isLiveSubscriptionState(input.existing?.subscriptionState)) {
      // The renewal that ends the plan, or the business switching before it, such as in Polar's billing portal.
      await tx.insert(auditLogs).values({ businessId: input.businessId, eventType: "billing.promo_ended", entityType: "billing_account", entityId: input.businessId, payload: { plan: left, to: input.plan, reason: input.existing?.endSetAt ? "ended" : "switched" } });
    }
    return { planCode: null, codeId: null, planEnds: null, ...noEnding };
  }
  const planCode = input.planCode;
  const sameSubscription = input.existing?.subscriptionId !== null && input.existing?.subscriptionId !== undefined && input.existing.subscriptionId === input.subscriptionId;
  // Retries, the several events of one checkout, and a paused or unpaid subscription that comes back find the account on the plan already.
  const entering = input.live && (input.existing?.planCode !== planCode || !sameSubscription);
  if (!entering) return {};
  const newestRequest = (only?: SQL) => tx.select({ codeId: billingCheckoutRequests.codeId }).from(billingCheckoutRequests)
    .where(and(eq(billingCheckoutRequests.businessId, input.businessId), eq(billingCheckoutRequests.planCode, planCode), sql`${billingCheckoutRequests.codeId} is not null`, only))
    .orderBy(sql`${billingCheckoutRequests.createdAt} desc`).limit(1);
  const [paid] = input.checkoutRequestId && isUuid(input.checkoutRequestId) ? await newestRequest(eq(billingCheckoutRequests.id, input.checkoutRequestId)) : [];
  const [request] = paid ? [paid] : await newestRequest();
  const codeId = request?.codeId ?? null;
  // A business uses a code once (migration 0113): moving onto its plan again, with a new subscription or by an older checkout's code, counts nothing.
  const [redeemed] = codeId === null ? [] : await tx.insert(billingCodeRedemptions).values({ codeId, businessId: input.businessId }).onConflictDoNothing().returning({ codeId: billingCodeRedemptions.codeId });
  if (redeemed) {
    await tx.execute(sql`update public.billing_codes set uses = uses + 1, updated_at = now() where id = ${redeemed.codeId}::uuid`);
    await tx.insert(auditLogs).values({ businessId: input.businessId, eventType: "billing.promo_code_redeemed", entityType: "billing_code", entityId: redeemed.codeId, payload: { plan: planCode } });
  }
  // Its first subscriber fixes a plan's terms, which the next apply then refuses to change. The
  // apply's lock, shared, keeps an apply that read the plan unfrozen from writing new terms after.
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext('lobbystack.billing_catalog'))`);
  const [row] = (await tx.execute<{ months: number | null; ends: string | null }>(sql`update public.billing_plans set frozen_at = coalesce(frozen_at, now()), updated_at = now() where code = ${planCode} returning months, ends`)).rows;
  const months = row?.months === null || row?.months === undefined || row.ends === "keep" ? null : Number(row.months);
  // A live subscription moved onto the plan within its period keeps that period, and Polar applies the plan's discount from the next one, so the months start at the renewal.
  const midPeriod = sameSubscription && isLiveSubscriptionState(input.existing?.subscriptionState) && input.periodStart !== undefined && input.existing?.currentPeriodStart?.getTime() === input.periodStart.getTime();
  const start = (midPeriod ? input.periodEnd : undefined) ?? input.periodStart ?? new Date();
  return { planCode, codeId, planEnds: months === null ? null : addMonths(start, months), ...noEnding };
}

/**
 * Whether a discount is a promo plan's own. Polar's billing portal keeps a
 * subscription's discount when the customer switches it to another product,
 * so a standard product can carry one, and the worker then removes it.
 */
async function isPromoPlanDiscount(tx: DatabaseTransaction, discountId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`select 1 from public.billing_plans where polar_disc = ${discountId} and code <> tier limit 1`)).rows;
  return rows.length > 0;
}

/**
 * What applying a stored Polar event did. processed: it applied, or had
 * already. ignored: it names no customer. missing: there is no such event.
 * held: a live subscription to a product no plan maps to, such as one made by
 * hand in Polar, which waits until the catalog links the product.
 */
export type BillingReconcileResult = "processed" | "ignored" | "missing" | "held";

export async function reconcileBillingProviderEvent(
  context: DomainContext,
  input: { businessId: string; providerEventId: string },
  env: Record<string, string | undefined> = process.env,
): Promise<BillingReconcileResult> {
  const outcome = await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx): Promise<{ result: BillingReconcileResult; started: SubscriptionStart | null }> => {
    let startedSubscription: SubscriptionStart | null = null;
    // The provider can deliver several live events for one checkout at once
    // (subscription.active beside order.paid). Without this lock both workers
    // read the same pre-paid account and each reports a subscription start, so
    // the event would count webhook races instead of subscriptions.
    await lockBillingAccount(tx, input.businessId);
    const event = (await tx.select({ id: providerEvents.id, providerEventId: providerEvents.providerEventId, eventType: providerEvents.eventType, status: providerEvents.status, payload: providerEvents.payload, createdAt: providerEvents.createdAt })
      .from(providerEvents)
      .where(and(eq(providerEvents.id, input.providerEventId), eq(providerEvents.businessId, input.businessId)))
      .limit(1))[0];
    if (!event) return { result: "missing", started: null };
    if (event.status === "processed") return { result: "processed", started: null };

    const payload = recordObject(event.payload);
    const transactionPayload = recordObject(payload.order ?? payload);
    const customer = recordObject(payload.customer);
    const subscription = recordObject(payload.subscription);
    const existing = (await tx.select({
      billingKey: billingAccounts.billingKey,
      customerId: billingAccounts.customerId,
      subscriptionId: billingAccounts.subscriptionId,
      plan: billingAccounts.plan,
      subscriptionState: billingAccounts.subscriptionState,
      billingInterval: billingAccounts.billingInterval,
      source: billingAccounts.source,
      planCode: billingAccounts.planCode,
      currentPeriodStart: billingAccounts.currentPeriodStart,
      endSetAt: billingAccounts.endSetAt,
    }).from(billingAccounts).where(eq(billingAccounts.businessId, input.businessId)).limit(1))[0];
    // The billing key is the external ID that usage and the billing portal name the business's Polar
    // customer by, and the checkout makes that customer with it, so an event never changes it. Polar
    // can put a subscription on a customer it matched by email, whose external ID names another
    // business, and Polar's own customer ID is no external ID at all, so usage sent with either
    // would never be billed to this business.
    const customerReference = stringField(transactionPayload, "billingKey", "externalCustomerId", "customerId") ?? stringField(payload, "billingKey", "externalCustomerId", "customerId") ?? stringField(customer, "id", "externalId");
    const billingKey = existing?.billingKey ?? (customerReference ? `business:${input.businessId}` : undefined);
    if (billingKey) {
      const customerId = stringField(transactionPayload, "customerId", "externalCustomerId") ?? stringField(payload, "customerId", "externalCustomerId") ?? stringField(customer, "id", "externalId") ?? existing?.customerId;
      // The subscription the event is about; an order may name none.
      const eventSubscriptionId = stringField(transactionPayload, "subscriptionId", "subscription_id") ?? stringField(payload, "subscriptionId", "subscription_id") ?? stringField(subscription, "id");
      const subscriptionId = eventSubscriptionId ?? existing?.subscriptionId;
      // The webhook names the plan of a product the catalog linked when the event arrived, a retired
      // price's product too. One linked while the event waited names its plan now.
      const productId = stringField(payload, "productId") ?? stringField(subscription, "product_id") ?? stringField(payload, "product_id");
      const named = stringField(transactionPayload, "plan") ?? stringField(payload, "plan");
      const linked = named || !productId ? null : polarProductLinks(await readBillingCatalogSnapshot(tx), env).planFor(productId);
      const plan = named ?? linked?.plan;
      // The exact plan the product sells, which differs from plan for a promo plan.
      const planCode = stringField(transactionPayload, "planCode") ?? stringField(payload, "planCode") ?? linked?.code;
      const billingInterval = stringField(transactionPayload, "billingInterval", "billing_interval", "interval") ?? stringField(payload, "billingInterval", "billing_interval", "interval") ?? stringField(subscription, "billingInterval", "billing_interval", "interval") ?? linked?.interval;
      // Only a subscription's own status is a subscription state. An order's status
      // (paid, refunded) is not, and an order without a nested subscription has none.
      const subscriptionState = stringField(transactionPayload, "subscriptionState") ?? stringField(payload, "subscriptionState") ?? (event.eventType.startsWith("subscription.") ? stringField(payload, "status") ?? event.eventType.slice("subscription.".length) : undefined);
      const currentPeriodStart = dateField(transactionPayload, "currentPeriodStart", "current_period_start") ?? dateField(payload, "currentPeriodStart", "current_period_start") ?? dateField(subscription, "currentPeriodStart", "current_period_start");
      const currentPeriodEnd = dateField(transactionPayload, "currentPeriodEnd", "current_period_end") ?? dateField(payload, "currentPeriodEnd", "current_period_end") ?? dateField(subscription, "currentPeriodEnd", "current_period_end");
      // The worker names its checkout request in a promo sale's metadata, which Polar keeps on the subscription.
      const checkoutRequestId = stringField(recordObject(subscription.metadata), "lobbystack_checkout") ?? stringField(recordObject(payload.metadata), "lobbystack_checkout");
      // A Polar retry or replay can arrive after a newer snapshot of the subscription was applied.
      // Both sides are normalized ISO strings (polar-event.ts), so text order is time order.
      const modifiedAt = stringField(payload, "subscriptionModifiedAt");
      const newerSnapshot = async (of: string | undefined, than: string) => (await tx.select({ id: providerEvents.id }).from(providerEvents)
        .where(and(eq(providerEvents.businessId, input.businessId), eq(providerEvents.status, "processed"), of === undefined ? undefined : sql`${providerEvents.payload}->>'subscriptionId' = ${of}`, sql`${providerEvents.payload}->>'subscriptionModifiedAt' > ${than}`))
        .limit(1)).length > 0;
      // An event about another subscription than the account's, such as one that ended before the
      // business subscribed again, never ends a live one, and applies only when no snapshot of the
      // account's is newer: a late event about the old subscription never undoes the new.
      const current = existing?.subscriptionId ?? undefined;
      const stale = eventSubscriptionId !== undefined && current !== undefined && eventSubscriptionId !== current
        ? (isLiveSubscriptionState(existing?.subscriptionState) && !isLiveSubscriptionState(subscriptionState)) || (modifiedAt !== undefined && await newerSnapshot(current, modifiedAt))
        : modifiedAt !== undefined && await newerSnapshot(eventSubscriptionId, modifiedAt);
      // An account whose plan the operator managed, now or before, changes only when the business
      // starts a live Starter or Pro subscription in Polar, which then takes over. Every other event,
      // such as a late cancellation of an older subscription or a product this deployment doesn't
      // map to a plan, leaves the account as the operator set it: a live managed plan stays live,
      // and an ended one keeps its enterprise plan from turning live again without a price.
      const managedSource = existing?.source === MANAGED_BILLING_SOURCE;
      const takesOver = managedSource && (plan === "starter" || plan === "pro") && isLiveSubscriptionState(subscriptionState);
      const keepsManagedPlan = managedSource && !takesOver;
      // A live subscription to a product no plan maps to would leave the business on the plan it had,
      // such as Pro after a switch in Polar's billing portal to a product made by hand. Its event stays
      // received, with the account as it was, until the catalog links the product: the sweep runs it
      // again each hour, and the worker reports it.
      if (!plan && productId && isLiveSubscriptionState(subscriptionState) && !stale && !keepsManagedPlan) return { result: "held", started: null };
      const polarFields = stale || keepsManagedPlan ? {} : {
        ...(takesOver ? { source: "polar" } : {}),
        ...(subscriptionId ? { subscriptionId } : {}),
        ...(plan ? { plan } : {}),
        ...(billingInterval ? { billingInterval } : {}),
        ...(subscriptionState ? { subscriptionState } : {}),
        ...(currentPeriodStart ? { currentPeriodStart } : {}),
        ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
      };
      const live = isLiveSubscriptionState(subscriptionState ?? existing?.subscriptionState);
      const subscriptionFields = {
        ...polarFields,
        ...(plan && !stale && !keepsManagedPlan ? await promoPlanFields(tx, { businessId: input.businessId, plan, planCode, existing, live, subscriptionId, periodStart: currentPeriodStart, periodEnd: currentPeriodEnd, checkoutRequestId }) : {}),
      };
      // A standard product that kept a promo plan's discount, as a switch in Polar's billing portal leaves it, loses it.
      const discountId = stringField(payload, "discountId");
      if (plan && (!planCode || planCode === plan) && !stale && !keepsManagedPlan && live && subscriptionId && discountId && await isPromoPlanDiscount(tx, discountId)) {
        await enqueueOutbox(tx, { topic: "billing.endPromoPlan", businessId: input.businessId, aggregateType: "billing_account", aggregateId: input.businessId, dedupeKey: `promo-discount-drop:${subscriptionId}:${discountId}`, payload: { dropDiscount: discountId, subscriptionId } });
      }
      // A takeover starts a Polar subscription even though the managed plan already counted as paid.
      startedSubscription = stale || keepsManagedPlan ? null : detectSubscriptionStart(takesOver ? { plan: existing?.plan ?? null, subscriptionState: null } : existing, {
        plan: plan ?? existing?.plan ?? null,
        subscriptionState: subscriptionState ?? existing?.subscriptionState ?? null,
        billingInterval: billingInterval ?? existing?.billingInterval ?? null,
      });
      await tx.insert(billingAccounts).values({
        businessId: input.businessId,
        billingKey,
        ...(customerId ? { customerId } : {}),
        ...subscriptionFields,
      }).onConflictDoUpdate({
        target: billingAccounts.businessId,
        set: {
          ...(customerId ? { customerId } : {}),
          ...subscriptionFields,
          updatedAt: new Date(),
        },
      });
    }

    // Refunds arrive as order.refunded (refund.* payloads name no business, so the webhook route drops them).
    const transactionKind = event.eventType.startsWith("order.") ? "order" : undefined;
    const sourceId = stringField(transactionPayload, "id", "orderId") ?? stringField(payload, "id", "orderId") ?? event.providerEventId;
    const amountCents = numberField(transactionPayload, "totalAmount", "total_amount", "amountCents", "amount") ?? numberField(payload, "totalAmount", "total_amount", "amountCents", "amount");
    const currency = stringField(transactionPayload, "currency") ?? stringField(payload, "currency");
    if (transactionKind && sourceId && amountCents !== undefined && currency) {
      const status = stringField(transactionPayload, "status") ?? stringField(payload, "status") ?? event.eventType.split(".").at(-1) ?? "received";
      const occurredAt = dateField(transactionPayload, "createdAt", "created_at", "occurredAt", "occurred_at") ?? dateField(payload, "createdAt", "created_at", "occurredAt", "occurred_at") ?? event.createdAt;
      const orderId = stringField(transactionPayload, "orderId", "order_id") ?? stringField(payload, "orderId", "order_id") ?? sourceId;
      const refundedCents = orderRefundedCents(transactionPayload, payload);
      const subscriptionId = stringField(transactionPayload, "subscriptionId", "subscription_id") ?? stringField(payload, "subscriptionId", "subscription_id");
      const polarCustomerId = stringField(transactionPayload, "customerId", "customer_id") ?? stringField(payload, "customerId", "customer_id");
      const description = stringField(transactionPayload, "description", "reason") ?? stringField(payload, "description", "reason");
      const invoiceUrl = stringField(transactionPayload, "invoiceUrl", "invoice_url") ?? stringField(payload, "invoiceUrl", "invoice_url");
      const [transaction] = await tx.insert(billingTransactions).values({
        businessId: input.businessId,
        kind: transactionKind,
        sourceId,
        status,
        amountCents,
        refundedAmountCents: refundedCents,
        currency: currency.toLowerCase(),
        ...(description ? { description } : {}),
        ...(invoiceUrl ? { invoiceUrl } : {}),
        ...(orderId ? { orderId } : {}),
        ...(subscriptionId ? { subscriptionId } : {}),
        ...(polarCustomerId ? { polarCustomerId } : {}),
        occurredAt,
        lastSyncedAt: new Date(),
      }).onConflictDoUpdate({
        target: [billingTransactions.kind, billingTransactions.sourceId],
        set: {
          businessId: input.businessId,
          // A late event, such as a paid one retried after the refund, never moves the order back.
          status: sql`case when ${orderStatusRank(billingTransactions.status)} > ${orderStatusRank(sql.raw("excluded.status"))} then ${billingTransactions.status} else excluded.status end`,
          amountCents,
          // Refunds only add up, so a paid event retried after a refund cannot erase it.
          refundedAmountCents: sql`greatest(${billingTransactions.refundedAmountCents}, excluded.refunded_amount_cents)`,
          currency: currency.toLowerCase(),
          ...(description ? { description } : {}),
          ...(invoiceUrl ? { invoiceUrl } : {}),
          ...(orderId ? { orderId } : {}),
          ...(subscriptionId ? { subscriptionId } : {}),
          ...(polarCustomerId ? { polarCustomerId } : {}),
          occurredAt,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        },
      }).returning({ id: billingTransactions.id });
      if (!transaction) throw new Error("Billing transaction could not be persisted.");
      await recordAffiliateCommissionInTransaction(tx, {
        businessId: input.businessId,
        billingTransactionId: transaction.id,
        kind: transactionKind,
        sourceId,
        status,
        amountCents: amountCents - refundedCents,
        currency,
        occurredAt,
      });
    }

    // The event commits with the reconciliation that produced it. Marking the
    // provider event processed after reporting it separately would lose the
    // start for good, because no later pass detects the same transition twice.
    if (startedSubscription) {
      await recordProductEventInTransaction(tx, {
        name: "billing.subscription_started",
        distinctId: getPostHogDistinctIdForBusinessSystem(input.businessId),
        businessId: input.businessId,
        actorType: "worker",
        // The taxonomy requires both, and null reads as missing: in a non-cloud
        // deployment that throws, which on this transaction would block the
        // payment itself. A first subscription has no previous plan to name.
        properties: {
          plan: startedSubscription.plan,
          billingInterval: startedSubscription.billingInterval ?? "unknown",
          previousPlan: startedSubscription.previousPlan ?? "none",
        },
      });
    }

    await tx.update(providerEvents).set({ status: billingKey ? "processed" : "ignored", updatedAt: new Date() }).where(eq(providerEvents.id, event.id));
    return { result: billingKey ? "processed" : "ignored", started: startedSubscription };
  });

  return outcome.result;
}
