import { and, asc, eq, sql } from "drizzle-orm";

import { billingAccounts, billingUsageEvents, billingUsageMonths, businesses, calls, enqueueOutbox, type DatabaseTransaction } from "@lobbystack/db";
import { billingErrorCodes, isBillingPlanSlug, isReplacedSubscription, isUuid, liveSubscriptionStates, MAX_PHONE_CALL_MS, PHONE_RESERVATION_SLICE_SECONDS, type BillingPlanLimits, type BillingPlanLimitTable, type BillingPlanSlug } from "@lobbystack/shared";

import { lockBusinessPacks, packBalance, readLivePacks, setPackDraw, type PackAllowance, type PackBalance } from "./billingPacks";
import { limitsFor, readBillingPlanLimitBook, type BillingPlanLimitBook } from "./billingPlans";

export type NonAiBillingUsageKind = "voice_seconds" | "alert_sms_segments" | "outbound_call_attempts" | "chat_ai_tokens";

type UsageCounts = Record<NonAiBillingUsageKind, number>;

export type UsageReservationResult = {
  allowed: boolean;
  errorCode: string | null;
  usageEventId?: string;
  syncNeeded: boolean;
  periodKey: string;
  plan: BillingPlanSlug;
  quantity?: number;
};

export type UsageStatus = {
  periodKey: string;
  plan: BillingPlanSlug;
  voiceSecondsUsed: number;
  alertSmsSegmentsUsed: number;
  outboundCallAttemptsUsed: number;
  chatAiTokensUsed: number;
  voiceSecondsIncluded: number | null;
  alertSmsSegmentsIncluded: number | null;
  outboundCallAttemptsIncluded: number | null;
  chatAiTokensIncluded: number | null;
  /** Usage past the allowance is billed rather than blocked. */
  overagesBillable: boolean;
  voiceOverageRatePerMinuteCents: number | null;
  voiceBlocked: boolean;
  alertSmsBlocked: boolean;
  outboundCallAttemptsBlocked: boolean;
  chatAiBlocked: boolean;
  overageSpendCents: number;
  overageSpendingCapCents: number | null;
  overageSpendingCapReached: boolean;
  /** The voice seconds phone and browser calls can still use this month; null when nothing limits them. */
  voiceSecondsLeft: number | null;
  usageComplete: boolean;
  /** The business's live prepaid packs, on the prepaid tier: their allowances for their whole length, which uses draw on instead of a monthly allowance. */
  pack: PackUsage | null;
};

/** What a business's live packs hold, as the usage status reports it: their voice seconds, and each other allowance for their whole length. */
export type PackUsage = {
  secondsTotal: number;
  secondsUsed: number;
  secondsLeft: number;
  alertSmsSegments: PackAllowance;
  outboundCallAttempts: PackAllowance;
  chatAiUnits: PackAllowance;
  /** When the live pack that ends first ends; null when none ends. */
  nextEndsAt: Date | null;
  /** When the last live pack ends; null when one never ends. */
  lastEndsAt: Date | null;
};

const emptyUsage: UsageCounts = {
  voice_seconds: 0,
  alert_sms_segments: 0,
  outbound_call_attempts: 0,
  chat_ai_tokens: 0,
};

const GSM_BASIC = new Set(Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ`¿abcdefghijklmnopqrstuvwxyzäöñüà"));
const GSM_EXTENDED = new Set(["^", "{", "}", "\\", "[", "~", "]", "|", "€"]);

export function periodKeyFor(value = new Date()): string {
  return value.toISOString().slice(0, 7);
}

export function estimateSmsSegments(body: string): number {
  let septets = 0;
  for (const character of body) {
    if (GSM_BASIC.has(character)) septets += 1;
    else if (GSM_EXTENDED.has(character)) septets += 2;
    else {
      // UCS-2 counts UTF-16 units, so an emoji takes two of a segment's 70.
      return body.length <= 70 ? 1 : Math.ceil(body.length / 67);
    }
  }
  return septets <= 160 ? 1 : Math.max(1, Math.ceil(septets / 153));
}

export function effectiveBillingPlan(input: { deploymentMode: string; accountPlan: string | null; subscriptionState: string | null }): BillingPlanSlug {
  if (input.deploymentMode !== "cloud") return "self_host";
  const paidState = (liveSubscriptionStates as readonly (string | null)[]).includes(input.subscriptionState);
  // Prepaid comes from live packs, never from the account's plan, so a stored "prepaid" counts as Free.
  if (isBillingPlanSlug(input.accountPlan) && input.accountPlan !== "prepaid" && (input.accountPlan === "free_cloud" || paidState)) return input.accountPlan;
  return "free_cloud";
}

function includedQuantity(config: BillingPlanLimits, kind: NonAiBillingUsageKind): number | null {
  if (kind === "voice_seconds") return config.voiceSecondsIncluded;
  if (kind === "alert_sms_segments") return config.alertSmsSegmentsIncluded;
  if (kind === "chat_ai_tokens") return config.chatAiTokensIncluded;
  return config.outboundCallAttemptsIncluded;
}

function limitReachedCode(kind: NonAiBillingUsageKind): string {
  if (kind === "voice_seconds") return billingErrorCodes.voiceLimitReached;
  if (kind === "alert_sms_segments") return billingErrorCodes.alertSmsLimitReached;
  if (kind === "chat_ai_tokens") return billingErrorCodes.chatAiLimitReached;
  return billingErrorCodes.outboundCallAttemptLimitReached;
}

function rateCents(config: BillingPlanLimits, kind: NonAiBillingUsageKind): number {
  if (kind === "voice_seconds") return (config.voiceOverageRatePerMinuteCents ?? 0) / 60;
  if (kind === "alert_sms_segments") return config.alertSmsOverageRatePerSegmentCents ?? 0;
  // Polar never bills website chats, so they never use the overage cap.
  if (kind === "chat_ai_tokens") return 0;
  return config.outboundCallAttemptOverageRateCents ?? 0;
}

function overageSpendFor(config: BillingPlanLimits, kind: NonAiBillingUsageKind, quantity: number): number {
  const included = includedQuantity(config, kind);
  if (!config.overagesBillable || included === null) return 0;
  return Math.max(0, quantity - included) * rateCents(config, kind);
}

type ReplayEvent = {
  sourceKey: string;
  quantity: number;
  usageKind: string;
  planAtRecordTime: string | null;
  /** The plan it counted under when that isn't its tier's standard plan. */
  planCodeAtRecordTime?: string | null | undefined;
  billingIntervalAtRecordTime: string | null;
  createdAt: Date;
  isFinal: boolean;
};

/** A business's plan: the tier it behaves as, and its own plan's code when that is a promo plan. */
export type PlanInForce = { plan: BillingPlanSlug; planCode: string | null };

// An event recorded without a plan counts under the plan in force now.
function eventLimits(event: ReplayEvent, current: PlanInForce, limits: BillingPlanLimitBook): BillingPlanLimits {
  return isBillingPlanSlug(event.planAtRecordTime) ? limitsFor(limits, event.planAtRecordTime, event.planCodeAtRecordTime) : limitsFor(limits, current.plan, current.planCode);
}

// Each event counts under the plan it was recorded on, at that plan's terms now.
export function replayEvents(events: ReplayEvent[], current: PlanInForce, limits: BillingPlanLimitBook): { usage: UsageCounts; rawSpendCents: number } {
  const usage = { ...emptyUsage };
  let rawSpendCents = 0;
  for (const event of [...events].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())) {
    if (!(event.usageKind in usage)) continue;
    const kind = event.usageKind as NonAiBillingUsageKind;
    const terms = eventLimits(event, current, limits);
    const before = usage[kind];
    const after = before + Math.max(0, event.quantity);
    usage[kind] = after;
    rawSpendCents += overageSpendFor(terms, kind, after) - overageSpendFor(terms, kind, before);
  }
  return { usage, rawSpendCents: Math.max(0, rawSpendCents) };
}

/**
 * noOverage: a Stripe account without its overage subscription, as before it's made or after Stripe ended it unpaid, so usage stops at the allowance.
 * allowancesSince: where the month's allowances start counting after a switch between a prepaid pack and a subscription; null or absent, the whole month.
 * packs: the live prepaid packs, on the prepaid tier.
 */
type BillingContext = PlanInForce & { capCents: number | null; billingInterval: string | null; noOverage?: boolean; allowancesSince?: Date | null; packs?: PackBalance | null };
// The business's plan with every plan's limits, which replaying the month needs.
type UsageContext = BillingContext & { limits: BillingPlanLimitBook };

// The limits of the plan in force: on the prepaid tier, those copied onto the live packs.
function currentLimits(billing: Pick<UsageContext, "plan" | "planCode" | "limits" | "noOverage" | "packs">): BillingPlanLimits {
  if (billing.plan === "prepaid" && billing.packs) return billing.packs.limits;
  const limits = limitsFor(billing.limits, billing.plan, billing.planCode);
  return billing.noOverage && limits.overagesBillable ? { ...limits, overagesBillable: false } : limits;
}

// Reservations, top-ups and corrections in a business's billing period run one at a time.
async function lockUsagePeriod(tx: DatabaseTransaction, businessId: string, periodKey: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing-usage:${businessId}:${periodKey}`}, 0))`);
}

// Usage that takes the month's spend from `before` to `after` pushes it past
// the cap only when it adds spend and ends above it. Included usage and
// website chats add none, so they still run once spend is over the cap, which
// a text estimated at one segment and billed as two, a lowered cap or a higher
// rate can each cause.
function pushesPastCap(capCents: number | null, before: number, after: number): boolean {
  return capCents !== null && after > capCents + 1e-9 && after > before + 1e-9;
}

// Self-host, and a paid plan with no overage cap, never run out of voice, so calls reserve nothing.
function hasUnlimitedVoice(billing: Pick<UsageContext, "plan" | "planCode" | "capCents" | "limits" | "packs">): boolean {
  return billing.plan === "self_host" || (currentLimits(billing).overagesBillable && billing.capCents === null);
}

// The voice seconds a limited plan can still reserve: its included seconds
// left, plus what the overage cap still pays for, which is no limit when extra
// minutes cost nothing. 0 on an unlimited plan. On the prepaid tier, what the
// live packs still hold, whatever the month's usage.
function reservableVoiceSeconds(billing: Pick<UsageContext, "plan" | "planCode" | "capCents" | "limits" | "packs">, current: { usage: UsageCounts; rawSpendCents: number }): number {
  if (billing.plan === "prepaid") return billing.packs?.secondsLeft ?? 0;
  const config = currentLimits(billing);
  const included = includedQuantity(config, "voice_seconds");
  const remainingIncluded = included === null ? 0 : Math.max(0, included - current.usage.voice_seconds);
  const remainingCap = billing.capCents === null ? 0 : Math.max(0, billing.capCents - current.rawSpendCents);
  const rate = rateCents(config, "voice_seconds");
  const capSeconds = rate > 0 ? Math.floor((remainingCap + 1e-9) / rate) : Number.POSITIVE_INFINITY;
  return config.overagesBillable ? (billing.capCents === null ? 0 : remainingIncluded + capSeconds) : remainingIncluded;
}

/** The billing account columns that decide a business's plan in force; undefined for a business without a billing account. */
export type PlanAccountColumns = { plan: string | null; planCode: string | null; subscriptionState: string | null; subscriptionId: string | null; replacedSubscriptionId: string | null } | null | undefined;

/** The tier a business's billing account puts it on before its packs count. */
function accountTier(deploymentMode: string, account: PlanAccountColumns): BillingPlanSlug {
  return effectiveBillingPlan({ deploymentMode, accountPlan: account?.plan ?? null, subscriptionState: accountSubscriptionState(account) });
}

// A subscription a prepaid pack replaced counts as ended while the provider confirms it (decision 6).
function accountSubscriptionState(account: PlanAccountColumns): string | null {
  return isReplacedSubscription(account) ? null : account?.subscriptionState ?? null;
}

/**
 * A business's plan in force from its deployment mode and billing account:
 * the tier effectiveBillingPlan gives, the prepaid tier instead of Free while
 * a pack has time left (livePack), and its promo plan's code while that
 * plan's subscription is live. loadBillingContext and the business cap per
 * plan (tenancy.ts) both read the plan this way.
 */
export function planInForce(deploymentMode: string, account: PlanAccountColumns, livePack: boolean): PlanInForce {
  const tier = accountTier(deploymentMode, account);
  // A business that would be on Free is on the prepaid tier while a pack has time left.
  const plan: BillingPlanSlug = tier === "free_cloud" && livePack ? "prepaid" : tier;
  // A promo plan counts only while its subscription is live, so a lapsed one is Free like any other.
  const live = (liveSubscriptionStates as readonly (string | null)[]).includes(accountSubscriptionState(account));
  return { plan, planCode: live && plan === account?.plan ? account.planCode ?? null : null };
}

export async function loadBillingContext(tx: DatabaseTransaction, businessId: string): Promise<BillingContext> {
  const [business] = await tx.select({ deploymentMode: businesses.deploymentMode }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  const [account] = await tx.select({ plan: billingAccounts.plan, planCode: billingAccounts.planCode, subscriptionState: billingAccounts.subscriptionState, overageSpendingCapCents: billingAccounts.overageSpendingCapCents, billingInterval: billingAccounts.billingInterval, source: billingAccounts.source, overageSubscriptionId: billingAccounts.overageSubscriptionId, subscriptionId: billingAccounts.subscriptionId, allowancesSince: billingAccounts.allowancesSince, replacedSubscriptionId: billingAccounts.replacedSubscriptionId }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId)).limit(1);
  const deploymentMode = business?.deploymentMode ?? "cloud";
  // Only a business that would be on Free reads its packs.
  const packs = accountTier(deploymentMode, account) === "free_cloud" ? packBalance(await readLivePacks(tx, businessId)) : null;
  const { plan, planCode } = planInForce(deploymentMode, account, packs !== null);
  return {
    plan,
    planCode,
    capCents: account?.overageSpendingCapCents ?? null,
    billingInterval: account?.billingInterval ?? null,
    noOverage: account?.source === "stripe" && !account.overageSubscriptionId,
    allowancesSince: account?.allowancesSince ?? null,
    packs,
  };
}

async function loadUsageContext(tx: DatabaseTransaction, businessId: string): Promise<UsageContext> {
  return { ...await loadBillingContext(tx, businessId), limits: await readBillingPlanLimitBook(tx) };
}

/**
 * The business's effective plan, its promo plan when it has one, the limits it
 * enforces now, and each tier's limits, which say what another plan would give.
 */
export async function loadBusinessPlanLimits(tx: DatabaseTransaction, businessId: string): Promise<PlanInForce & { limits: BillingPlanLimits; tiers: BillingPlanLimitTable }> {
  const billing = await loadUsageContext(tx, businessId);
  return { plan: billing.plan, planCode: billing.planCode, limits: currentLimits(billing), tiers: billing.limits.tiers };
}

// Where the period's allowances start counting: from allowances_since when a
// switch between a pack and a subscription set it inside the period, else the
// whole period. Null for every business that never switched.
function windowStart(billing: Pick<BillingContext, "allowancesSince">, periodKey: string): Date | null {
  const since = billing.allowancesSince ?? null;
  return since && periodKeyFor(since) === periodKey ? since : null;
}

/**
 * The period's events that count against the plan in force: those since its
 * window started, and a pack's only on the prepaid tier, since a pack paid for
 * them. For a business that never had a pack, every event, as before packs.
 */
function countedEvents(events: ReplayEvent[], billing: Pick<BillingContext, "plan" | "allowancesSince">, periodKey: string): ReplayEvent[] {
  const start = windowStart(billing, periodKey);
  return events.filter((event) => (start === null || event.createdAt >= start) && (billing.plan === "prepaid" || event.planAtRecordTime !== "prepaid"));
}

/**
 * The events a row recorded at createdAt counts with: those in the same part
 * of the period, before or after the switch, so a call or a late correction
 * stays in the part it started in. A row that isn't a pack's never counts a
 * pack's, as countedEvents counts them only on the prepaid tier: a Free call
 * running when a pack comes back or another is bought keeps Free's allowance.
 */
function segmentEvents(events: ReplayEvent[], billing: Pick<BillingContext, "allowancesSince">, periodKey: string, row: Pick<ReplayEvent, "createdAt" | "planAtRecordTime">): ReplayEvent[] {
  const start = windowStart(billing, periodKey);
  const offPack = row.planAtRecordTime !== "prepaid";
  return events.filter((event) => (start === null || (event.createdAt >= start) === (row.createdAt >= start)) && !(offPack && event.planAtRecordTime === "prepaid"));
}

/** Whether a row recorded at createdAt is in a part of the period before the latest switch. */
function beforeSwitch(billing: Pick<BillingContext, "allowancesSince">, periodKey: string, createdAt: Date): boolean {
  const start = windowStart(billing, periodKey);
  return start !== null && createdAt < start;
}

/**
 * The plan whose sync rule a usage row's change follows: a pack's row stays
 * skipped whatever the plan in force, and a Starter or Pro row changed once
 * the business is on a pack still goes to the provider, which bills the
 * subscription it replaced. Otherwise the plan in force, as before packs.
 */
function syncPlanFor(rowPlan: string | null, billing: Pick<PlanInForce, "plan">): BillingPlanSlug {
  if (rowPlan === "prepaid") return "prepaid";
  if (billing.plan === "prepaid" && (rowPlan === "starter" || rowPlan === "pro")) return rowPlan;
  return billing.plan;
}

async function loadEvents(tx: DatabaseTransaction, businessId: string, periodKey: string): Promise<ReplayEvent[]> {
  return await tx.select({ sourceKey: billingUsageEvents.sourceKey, quantity: billingUsageEvents.quantity, usageKind: billingUsageEvents.usageKind, planAtRecordTime: billingUsageEvents.planAtRecordTime, planCodeAtRecordTime: billingUsageEvents.planCodeAtRecordTime, billingIntervalAtRecordTime: billingUsageEvents.billingIntervalAtRecordTime, createdAt: billingUsageEvents.createdAt, isFinal: billingUsageEvents.isFinal })
    .from(billingUsageEvents)
    .where(and(eq(billingUsageEvents.businessId, businessId), eq(billingUsageEvents.periodKey, periodKey)))
    .orderBy(asc(billingUsageEvents.createdAt));
}

// Starter and Pro send Polar each event's share of the month's overage once it
// is final, on monthly and annual subscriptions alike, so the allowance resets
// on the first of each UTC month whatever day the subscription renews, and
// Polar's products need no Credits. Only the other final events have been
// billed, so open reservations never count against this one. An event that
// was already final keeps what it billed and moves only by its own change.
export function billableQuantityForEvent(others: ReplayEvent[], event: ReplayEvent, current: PlanInForce, limits: BillingPlanLimitBook, billed?: { quantity: number; billableQuantity: number }): number {
  const plan = isBillingPlanSlug(event.planAtRecordTime) ? event.planAtRecordTime : current.plan;
  const included = includedQuantity(eventLimits(event, current, limits), event.usageKind as NonAiBillingUsageKind);
  if ((plan !== "starter" && plan !== "pro") || included === null) return Math.max(0, event.quantity);
  const before = others.reduce((sum, row) => (row.isFinal && row.usageKind === event.usageKind ? sum + Math.max(0, row.quantity) : sum), 0);
  const overage = (quantity: number) => Math.max(0, before + Math.max(0, quantity) - included);
  return billed ? Math.max(0, billed.billableQuantity + overage(event.quantity) - overage(billed.quantity)) : overage(event.quantity) - overage(0);
}

async function ensureUsageMonth(tx: DatabaseTransaction, businessId: string, periodKey: string, plan: BillingPlanSlug): Promise<void> {
  await tx.insert(billingUsageMonths).values({ businessId, periodKey, planAtSnapshot: plan }).onConflictDoNothing({ target: [billingUsageMonths.businessId, billingUsageMonths.periodKey] });
}

function usageStatusFrom(input: { periodKey: string; billing: UsageContext; events: ReplayEvent[] }): UsageStatus {
  const { billing } = input;
  const events = countedEvents(input.events, billing, input.periodKey);
  const replay = replayEvents(events, billing, billing.limits);
  const config = currentLimits(billing);
  const overageSpendCents = Math.max(0, Math.ceil(replay.rawSpendCents - 1e-9));
  const capReached = billing.capCents !== null && replay.rawSpendCents > 0 && overageSpendCents >= billing.capCents;
  // On a pack every use draws on the live packs' allowance of its kind, which
  // lasts their whole length rather than a month.
  const pack = billing.plan === "prepaid" && billing.packs ? billing.packs : null;
  // A kind is blocked once its allowance is used up and it can't run past it:
  // Free never can, and a capped plan can't once one more unit would push
  // spend past the cap. A paid plan's chats cost nothing past their allowance,
  // so the cap never blocks them. On a pack, once the packs hold none of it.
  const blocked = (kind: NonAiBillingUsageKind): boolean => {
    if (billing.plan === "prepaid") return (pack?.allowances[kind].left ?? 0) <= 0;
    const included = includedQuantity(config, kind);
    if (included === null || replay.usage[kind] < included) return false;
    return !config.overagesBillable || pushesPastCap(billing.capCents, replay.rawSpendCents, replay.rawSpendCents + rateCents(config, kind));
  };
  const voiceSecondsLeft = hasUnlimitedVoice(billing) ? Number.POSITIVE_INFINITY : reservableVoiceSeconds(billing, replay);
  return {
    periodKey: input.periodKey,
    plan: billing.plan,
    voiceSecondsUsed: replay.usage.voice_seconds,
    alertSmsSegmentsUsed: replay.usage.alert_sms_segments,
    outboundCallAttemptsUsed: replay.usage.outbound_call_attempts,
    chatAiTokensUsed: replay.usage.chat_ai_tokens,
    voiceSecondsIncluded: config.voiceSecondsIncluded,
    alertSmsSegmentsIncluded: config.alertSmsSegmentsIncluded,
    outboundCallAttemptsIncluded: config.outboundCallAttemptsIncluded,
    chatAiTokensIncluded: config.chatAiTokensIncluded,
    overagesBillable: config.overagesBillable,
    voiceOverageRatePerMinuteCents: config.voiceOverageRatePerMinuteCents,
    voiceBlocked: blocked("voice_seconds"),
    alertSmsBlocked: blocked("alert_sms_segments"),
    outboundCallAttemptsBlocked: blocked("outbound_call_attempts"),
    chatAiBlocked: blocked("chat_ai_tokens"),
    overageSpendCents,
    overageSpendingCapCents: billing.capCents,
    overageSpendingCapReached: capReached,
    voiceSecondsLeft: Number.isFinite(voiceSecondsLeft) ? voiceSecondsLeft : null,
    usageComplete: events.every((event) => event.isFinal),
    pack: pack ? { secondsTotal: pack.secondsTotal, secondsUsed: pack.secondsUsed, secondsLeft: pack.secondsLeft, alertSmsSegments: pack.allowances.alert_sms_segments, outboundCallAttempts: pack.allowances.outbound_call_attempts, chatAiUnits: pack.allowances.chat_ai_tokens, nextEndsAt: pack.nextEndsAt, lastEndsAt: pack.lastEndsAt } : null,
  };
}

async function refreshUsageMonth(tx: DatabaseTransaction, input: { businessId: string; periodKey: string; billing: UsageContext; events?: ReplayEvent[] }): Promise<UsageStatus> {
  const events = input.events ?? await loadEvents(tx, input.businessId, input.periodKey);
  const status = usageStatusFrom({ periodKey: input.periodKey, billing: input.billing, events });
  await ensureUsageMonth(tx, input.businessId, input.periodKey, input.billing.plan);
  await tx.update(billingUsageMonths).set({
    planAtSnapshot: input.billing.plan,
    voiceSecondsUsed: status.voiceSecondsUsed,
    alertSmsSegmentsUsed: status.alertSmsSegmentsUsed,
    outboundCallAttemptsUsed: status.outboundCallAttemptsUsed,
    chatAiTokensUsed: status.chatAiTokensUsed,
    voiceBlocked: status.voiceBlocked,
    alertSmsBlocked: status.alertSmsBlocked,
    outboundCallAttemptsBlocked: status.outboundCallAttemptsBlocked,
    chatAiBlocked: status.chatAiBlocked,
    overageSpendCents: status.overageSpendCents,
    lastRecordedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(billingUsageMonths.businessId, input.businessId), eq(billingUsageMonths.periodKey, input.periodKey)));
  return status;
}

export async function getUsageStatusInTransaction(tx: DatabaseTransaction, input: { businessId: string; periodKey?: string }): Promise<UsageStatus> {
  const periodKey = input.periodKey ?? periodKeyFor();
  // Every writer takes this lock before the month row, so a status read
  // followed by a reservation cannot deadlock with a call reserving first.
  await lockUsagePeriod(tx, input.businessId, periodKey);
  const billing = await loadUsageContext(tx, input.businessId);
  return await refreshUsageMonth(tx, { businessId: input.businessId, periodKey, billing });
}

// The same count without the period lock or saving the month's row, for checks
// that only decide what to offer, such as the website chat's settings: they
// don't wait behind a call reserving its minutes. Using an allowance reserves
// it, and the reservation locks and counts again.
export async function readUsageStatusInTransaction(tx: DatabaseTransaction, input: { businessId: string; periodKey?: string }): Promise<UsageStatus> {
  const periodKey = input.periodKey ?? periodKeyFor();
  const billing = await loadUsageContext(tx, input.businessId);
  const events = await loadEvents(tx, input.businessId, periodKey);
  return usageStatusFrom({ periodKey, billing, events });
}

export async function reserveUsageInTransaction(tx: DatabaseTransaction, input: { businessId: string; usageKind: NonAiBillingUsageKind; sourceKey: string; quantity?: number | undefined; recordedAt?: Date | undefined }): Promise<UsageReservationResult> {
  const recordedAt = input.recordedAt ?? new Date();
  const periodKey = periodKeyFor(recordedAt);
  await lockUsagePeriod(tx, input.businessId, periodKey);
  let billing = await loadUsageContext(tx, input.businessId);
  const existing = (await tx.select({ id: billingUsageEvents.id, quantity: billingUsageEvents.quantity, billableQuantity: billingUsageEvents.billableQuantity, syncStatus: billingUsageEvents.syncStatus, syncedQuantity: billingUsageEvents.syncedQuantity, syncSeq: billingUsageEvents.syncSeq }).from(billingUsageEvents).where(and(eq(billingUsageEvents.businessId, input.businessId), eq(billingUsageEvents.sourceKey, input.sourceKey))).limit(1).for("update"))[0];
  if (existing && existing.quantity > 0) return { allowed: true, errorCode: null, usageEventId: existing.id, syncNeeded: existing.syncStatus === "pending", periodKey, plan: billing.plan, quantity: existing.quantity };
  // On a pack every use comes from the packs, which span months, so only their
  // lock keeps two uses from drawing the same balance.
  const fromPacks = billing.plan === "prepaid";
  if (fromPacks) {
    await lockBusinessPacks(tx, input.businessId);
    billing = { ...billing, packs: packBalance(await readLivePacks(tx, input.businessId)) };
  }
  const events = await loadEvents(tx, input.businessId, periodKey);
  const counted = countedEvents(events, billing, periodKey);
  const current = replayEvents(counted, billing, billing.limits);
  let quantity = input.quantity;
  // A phone call reserves one slice and the worker tops it up as the call
  // runs, so concurrent calls share what remains.
  if (quantity === undefined && input.usageKind === "voice_seconds") quantity = Math.min(PHONE_RESERVATION_SLICE_SECONDS, reservableVoiceSeconds(billing, current));
  quantity = Math.max(0, quantity ?? 0);
  if (quantity <= 0) {
    if (input.usageKind === "voice_seconds" && hasUnlimitedVoice(billing)) return { allowed: true, errorCode: null, syncNeeded: false, periodKey, plan: billing.plan };
    return { allowed: false, errorCode: limitReachedCode(input.usageKind), syncNeeded: false, periodKey, plan: billing.plan };
  }
  // A use never reserves more than the packs still hold of its kind.
  if (fromPacks && quantity > (billing.packs?.allowances[input.usageKind].left ?? 0)) {
    return { allowed: false, errorCode: limitReachedCode(input.usageKind), syncNeeded: false, periodKey, plan: billing.plan };
  }
  const limits = currentLimits(billing);
  const included = includedQuantity(limits, input.usageKind);
  if (!limits.overagesBillable && included !== null && current.usage[input.usageKind] + quantity > included) {
    return { allowed: false, errorCode: limitReachedCode(input.usageKind), syncNeeded: false, periodKey, plan: billing.plan };
  }
  const eventPayload = { sourceKey: input.sourceKey, quantity, usageKind: input.usageKind, planAtRecordTime: billing.plan, planCodeAtRecordTime: billing.planCode, billingIntervalAtRecordTime: billing.billingInterval, createdAt: recordedAt, isFinal: input.usageKind === "outbound_call_attempts" || input.usageKind === "chat_ai_tokens" };
  const simulated = replayEvents([...counted, eventPayload], billing, billing.limits);
  if (pushesPastCap(billing.capCents, current.rawSpendCents, simulated.rawSpendCents)) {
    return { allowed: false, errorCode: limitReachedCode(input.usageKind), syncNeeded: false, periodKey, plan: billing.plan };
  }
  const syncNeeded = billing.plan === "starter" || billing.plan === "pro";
  const others = events.filter((row) => row.sourceKey !== input.sourceKey);
  const billableQuantity = billableQuantityForEvent(countedEvents(others, billing, periodKey), eventPayload, billing, billing.limits);
  const [event] = existing
    ? await tx.update(billingUsageEvents).set({ quantity, billableQuantity, planAtRecordTime: billing.plan, planCodeAtRecordTime: billing.planCode, billingIntervalAtRecordTime: billing.billingInterval, isFinal: eventPayload.isFinal, ...usageSyncFields(existing, billableQuantity, billing.plan), updatedAt: new Date() }).where(eq(billingUsageEvents.id, existing.id)).returning({ id: billingUsageEvents.id })
    : await tx.insert(billingUsageEvents).values({ businessId: input.businessId, periodKey, sourceKey: input.sourceKey, usageKind: input.usageKind, quantity, billableQuantity, planAtRecordTime: billing.plan, planCodeAtRecordTime: billing.planCode, billingIntervalAtRecordTime: billing.billingInterval, isFinal: eventPayload.isFinal, syncStatus: syncNeeded ? "pending" : "skipped", createdAt: recordedAt, updatedAt: new Date() }).returning({ id: billingUsageEvents.id });
  if (!event) throw new Error("Billing usage event could not be recorded.");
  if (fromPacks) billing = { ...billing, packs: (await setPackDraw(tx, { businessId: input.businessId, sourceKey: input.sourceKey, usageKind: input.usageKind, seconds: quantity })).after };
  await refreshUsageMonth(tx, { businessId: input.businessId, periodKey, billing, events: [...others, eventPayload] });
  return { allowed: true, errorCode: null, usageEventId: event.id, syncNeeded, periodKey, plan: billing.plan, quantity };
}

/**
 * The terms a call that began on another plan keeps once a switch to or from
 * a pack happened during it: its own plan's, within its own part of the
 * month, never a pack's, since a pack pays only for calls made on it.
 */
function rowTerms(billing: UsageContext, row: Pick<ReplayEvent, "planAtRecordTime" | "planCodeAtRecordTime">): UsageContext {
  const plan = isBillingPlanSlug(row.planAtRecordTime) && row.planAtRecordTime !== "prepaid" ? row.planAtRecordTime : "free_cloud";
  return { ...billing, plan, planCode: row.planCodeAtRecordTime ?? null, packs: null };
}

/**
 * Grows a phone call's reservation while the call runs: by one slice, or by
 * what the plan has left, and never past MAX_PHONE_CALL_MS for the call.
 * Returns the seconds granted, 0 when the call has ended, is a browser call,
 * holds no reservation (an unlimited plan), or has nothing left to grow by.
 * Like the first reservation it queues no Polar sync: the call's finish
 * corrects the event to the real seconds and syncs those. A call that began
 * on a pack grows only from the packs, and stops growing once none is live.
 */
export async function extendPhoneReservationInTransaction(tx: DatabaseTransaction, input: { businessId: string; callId: string }): Promise<number> {
  const sourceKey = `voice:${input.callId}`;
  const reservation = (await tx.select({ id: billingUsageEvents.id, periodKey: billingUsageEvents.periodKey }).from(billingUsageEvents).where(and(eq(billingUsageEvents.businessId, input.businessId), eq(billingUsageEvents.sourceKey, sourceKey))).limit(1))[0];
  if (!reservation) return 0;
  await lockUsagePeriod(tx, input.businessId, reservation.periodKey);
  // Read under the lock, so a finish that took it first wins. Browser calls
  // reserve their whole length up front.
  const call = (await tx.select({ endedAt: calls.endedAt, transport: calls.transport }).from(calls).where(and(eq(calls.id, input.callId), eq(calls.businessId, input.businessId))).limit(1))[0];
  if (!call || call.endedAt !== null || call.transport === "web_voice") return 0;
  const billing = await loadUsageContext(tx, input.businessId);
  const events = await loadEvents(tx, input.businessId, reservation.periodKey);
  const event = events.find((row) => row.sourceKey === sourceKey);
  if (!event) return 0;
  if (event.planAtRecordTime === "prepaid") {
    if (billing.plan !== "prepaid") return 0;
    await lockBusinessPacks(tx, input.businessId);
    const packs = packBalance(await readLivePacks(tx, input.businessId));
    const granted = Math.min(PHONE_RESERVATION_SLICE_SECONDS, packs?.secondsLeft ?? 0, MAX_PHONE_CALL_MS / 1_000 - event.quantity);
    if (granted <= 0) return 0;
    const quantity = event.quantity + granted;
    await tx.update(billingUsageEvents).set({ quantity, billableQuantity: quantity, updatedAt: new Date() }).where(eq(billingUsageEvents.id, reservation.id));
    const drawn = await setPackDraw(tx, { businessId: input.businessId, sourceKey, seconds: quantity });
    const replayed = events.map((row) => (row === event ? { ...row, quantity } : row));
    await refreshUsageMonth(tx, { businessId: input.businessId, periodKey: reservation.periodKey, billing: { ...billing, packs: drawn.after }, events: replayed });
    return granted;
  }
  // A call that began before a switch to or from a pack, or on another plan
  // while a pack is in force, runs on under its own plan within its part of
  // the month. Every other call grows under the plan in force, as before packs.
  const own = billing.plan === "prepaid" || beforeSwitch(billing, reservation.periodKey, event.createdAt);
  const terms = own ? rowTerms(billing, event) : billing;
  const scope = own ? segmentEvents(events, billing, reservation.periodKey, event) : countedEvents(events, billing, reservation.periodKey);
  // The replay already counts this call's reservation. A plan upgraded to
  // unlimited mid-call still grows it, up to the longest call.
  const current = replayEvents(scope, terms, terms.limits);
  const free = hasUnlimitedVoice(terms) ? Number.POSITIVE_INFINITY : reservableVoiceSeconds(terms, current);
  const granted = Math.min(PHONE_RESERVATION_SLICE_SECONDS, free, MAX_PHONE_CALL_MS / 1_000 - event.quantity);
  if (granted <= 0) return 0;
  const grown = scope.map((row) => (row === event ? { ...row, quantity: row.quantity + granted } : row));
  if (pushesPastCap(terms.capCents, current.rawSpendCents, replayEvents(grown, terms, terms.limits).rawSpendCents)) return 0;
  const billableQuantity = billableQuantityForEvent(scope.filter((row) => row !== event), { ...event, quantity: event.quantity + granted }, terms, terms.limits);
  await tx.update(billingUsageEvents).set({ quantity: event.quantity + granted, billableQuantity, updatedAt: new Date() }).where(eq(billingUsageEvents.id, reservation.id));
  const replayed = events.map((row) => (row === event ? { ...row, quantity: row.quantity + granted } : row));
  await refreshUsageMonth(tx, { businessId: input.businessId, periodKey: reservation.periodKey, billing, events: replayed });
  return granted;
}

/** The plan a new usage row is recorded under, and when. */
type RowRecording = { plan: BillingPlanSlug; planCode: string | null; billingInterval: string | null; createdAt: Date };

/**
 * How a phone call that ends on a pack is recorded when it began before the
 * switch to it on a plan that reserved nothing, as Starter or Pro without a
 * spending cap does, so it has no row yet: under the account's own plan, the
 * one the pack replaced, just before the switch, so it counts with that
 * plan's usage, goes to the provider as that plan's usage does, and draws
 * nothing from the pack. Null for any other row, and at once for a business
 * that isn't on a pack.
 */
async function recordingBeforePackSwitch(tx: DatabaseTransaction, input: { businessId: string; sourceKey: string; billing: BillingContext }): Promise<RowRecording | null> {
  const since = input.billing.allowancesSince ?? null;
  const callId = input.sourceKey.startsWith("voice:") ? input.sourceKey.slice("voice:".length) : null;
  if (input.billing.plan !== "prepaid" || !since || !isUuid(callId)) return null;
  const [call] = await tx.select({ startedAt: calls.startedAt }).from(calls).where(and(eq(calls.id, callId), eq(calls.businessId, input.businessId))).limit(1);
  if (!call || call.startedAt >= since) return null;
  const [account] = await tx.select({ plan: billingAccounts.plan, planCode: billingAccounts.planCode, billingInterval: billingAccounts.billingInterval }).from(billingAccounts).where(eq(billingAccounts.businessId, input.businessId)).limit(1);
  const stored = account?.plan ?? null;
  const plan: BillingPlanSlug = isBillingPlanSlug(stored) && stored !== "prepaid" ? stored : "free_cloud";
  return { plan, planCode: plan === stored ? account?.planCode ?? null : null, billingInterval: account?.billingInterval ?? null, createdAt: new Date(since.getTime() - 1) };
}

export async function correctUsageInTransaction(tx: DatabaseTransaction, input: { businessId: string; sourceKey: string; usageKind: NonAiBillingUsageKind; quantity: number; recordedAt?: Date | undefined }): Promise<string> {
  const recordedAt = input.recordedAt ?? new Date();
  const existingBeforeLock = (await tx.select({ id: billingUsageEvents.id, periodKey: billingUsageEvents.periodKey }).from(billingUsageEvents).where(and(eq(billingUsageEvents.businessId, input.businessId), eq(billingUsageEvents.sourceKey, input.sourceKey))).limit(1))[0];
  let periodKey = existingBeforeLock?.periodKey ?? periodKeyFor(recordedAt);
  await lockUsagePeriod(tx, input.businessId, periodKey);
  const billing = await loadUsageContext(tx, input.businessId);
  // Locked, so the worker's claim and confirmation of its Polar event wait for the correction.
  const existing = (await tx.select({ id: billingUsageEvents.id, periodKey: billingUsageEvents.periodKey, planAtRecordTime: billingUsageEvents.planAtRecordTime, planCodeAtRecordTime: billingUsageEvents.planCodeAtRecordTime, billingIntervalAtRecordTime: billingUsageEvents.billingIntervalAtRecordTime, createdAt: billingUsageEvents.createdAt, quantity: billingUsageEvents.quantity, billableQuantity: billingUsageEvents.billableQuantity, isFinal: billingUsageEvents.isFinal, syncStatus: billingUsageEvents.syncStatus, syncedQuantity: billingUsageEvents.syncedQuantity, syncSeq: billingUsageEvents.syncSeq }).from(billingUsageEvents).where(and(eq(billingUsageEvents.businessId, input.businessId), eq(billingUsageEvents.sourceKey, input.sourceKey))).limit(1).for("update"))[0];
  let eventId: string;
  let draws = false;
  if (existing) {
    const events = await loadEvents(tx, input.businessId, periodKey);
    // A correction keeps the plan the usage was recorded under.
    const replacement: ReplayEvent = { sourceKey: input.sourceKey, quantity: Math.max(0, input.quantity), usageKind: input.usageKind, planAtRecordTime: existing.planAtRecordTime ?? billing.plan, planCodeAtRecordTime: existing.planAtRecordTime ? existing.planCodeAtRecordTime : billing.planCode, billingIntervalAtRecordTime: existing.billingIntervalAtRecordTime ?? billing.billingInterval, createdAt: existing.createdAt, isFinal: true };
    const billed = existing.isFinal ? { quantity: existing.quantity, billableQuantity: existing.billableQuantity ?? existing.quantity } : undefined;
    // It counts with the usage in its own part of the month, before or after a switch to or from a pack.
    const others = segmentEvents(events, billing, periodKey, replacement).filter((row) => row.sourceKey !== input.sourceKey);
    const billableQuantity = billableQuantityForEvent(others, replacement, billing, billing.limits, billed);
    await tx.update(billingUsageEvents).set({ quantity: Math.max(0, input.quantity), billableQuantity, isFinal: true, ...usageSyncFields(existing, billableQuantity, syncPlanFor(existing.planAtRecordTime, billing)), updatedAt: new Date() }).where(eq(billingUsageEvents.id, existing.id));
    eventId = existing.id;
    draws = existing.planAtRecordTime === "prepaid";
  } else {
    const before = await recordingBeforePackSwitch(tx, { businessId: input.businessId, sourceKey: input.sourceKey, billing });
    if (before && periodKeyFor(before.createdAt) !== periodKey) {
      // A call that ran on into the next month stays in the month it is recorded in, just before the switch, and takes that month's lock too.
      periodKey = periodKeyFor(before.createdAt);
      await lockUsagePeriod(tx, input.businessId, periodKey);
    }
    const row = before ?? { plan: billing.plan, planCode: billing.planCode, billingInterval: billing.billingInterval, createdAt: recordedAt };
    const replacement: ReplayEvent = { sourceKey: input.sourceKey, quantity: Math.max(0, input.quantity), usageKind: input.usageKind, planAtRecordTime: row.plan, planCodeAtRecordTime: row.planCode, billingIntervalAtRecordTime: row.billingInterval, createdAt: row.createdAt, isFinal: true };
    const events = await loadEvents(tx, input.businessId, periodKey);
    // A call from before the switch counts with the usage before it, as one that reserved there does.
    const billableQuantity = billableQuantityForEvent(before ? segmentEvents(events, billing, periodKey, replacement) : countedEvents(events, billing, periodKey), replacement, billing, billing.limits);
    const [event] = await tx.insert(billingUsageEvents).values({ businessId: input.businessId, periodKey, sourceKey: input.sourceKey, usageKind: input.usageKind, quantity: Math.max(0, input.quantity), billableQuantity, planAtRecordTime: row.plan, planCodeAtRecordTime: row.planCode, billingIntervalAtRecordTime: row.billingInterval, isFinal: true, syncStatus: row.plan === "starter" || row.plan === "pro" ? "pending" : "skipped", createdAt: row.createdAt, updatedAt: new Date() }).returning({ id: billingUsageEvents.id });
    if (!event) throw new Error("Billing usage correction could not be recorded.");
    eventId = event.id;
    draws = row.plan === "prepaid";
  }
  // A use made on a pack settles what it drew: what a call or a text didn't
  // use goes back to the packs, and more than it reserved comes from them as
  // far as they hold it.
  let packs = billing.packs ?? null;
  if (draws) {
    const drawn = await setPackDraw(tx, { businessId: input.businessId, sourceKey: input.sourceKey, usageKind: input.usageKind, seconds: Math.max(0, input.quantity) });
    if (billing.plan === "prepaid") packs = drawn.after;
  }
  await refreshUsageMonth(tx, { businessId: input.businessId, periodKey, billing: { ...billing, packs } });
  return eventId;
}

/**
 * Queues a usage event's sync to Polar once it is final. A reservation's
 * estimate waits for the correction that settles it, which queues it then: a
 * sync queued earlier would be skipped, and its key would keep the settled
 * quantity from being queued when it matches the estimate. After the first
 * event Polar took, the key also names the next event's number, so a
 * correction queues a sync for its difference.
 */
export async function enqueueUsageSyncInTransaction(tx: DatabaseTransaction, input: { businessId: string; usageEventId: string }): Promise<void> {
  const event = (await tx.select({ quantity: billingUsageEvents.quantity, syncStatus: billingUsageEvents.syncStatus, isFinal: billingUsageEvents.isFinal, syncSeq: billingUsageEvents.syncSeq }).from(billingUsageEvents).where(and(eq(billingUsageEvents.id, input.usageEventId), eq(billingUsageEvents.businessId, input.businessId))).limit(1))[0];
  if (!event || event.syncStatus !== "pending" || !event.isFinal) return;
  await enqueueOutbox(tx, {
    topic: "billing.syncUsage",
    businessId: input.businessId,
    aggregateType: "billing_usage_event",
    aggregateId: input.usageEventId,
    dedupeKey: `billing-usage:${input.usageEventId}:sync:${event.quantity}${event.syncSeq === 0 ? "" : `:${event.syncSeq}`}`,
    payload: { usageEventId: input.usageEventId },
  });
}

/**
 * The sync columns a usage row's change writes. A row Polar has, synced or
 * the legacy succeeded, stays so when the change leaves its billable quantity
 * where Polar has it, as when Twilio settles on the estimated segments; any
 * other change is pending on Starter and Pro, and skipped on other plans.
 * Before migration 0116 a synced row's whole billable quantity went to Polar
 * as its first event, which the row then records.
 */
function usageSyncFields(row: { syncStatus: string; quantity: number; billableQuantity: number | null; syncedQuantity: number | null; syncSeq: number }, billableQuantity: number, plan: BillingPlanSlug): { syncStatus: string; syncedQuantity?: number; syncSeq?: number } {
  const sent = row.syncStatus === "synced" || row.syncStatus === "succeeded";
  const legacy = sent && row.syncedQuantity === null ? { syncedQuantity: row.billableQuantity ?? row.quantity, syncSeq: Math.max(row.syncSeq, 1) } : {};
  const syncedQuantity = legacy.syncedQuantity ?? row.syncedQuantity;
  if (plan !== "starter" && plan !== "pro") return { syncStatus: "skipped", ...legacy };
  return { syncStatus: sent && syncedQuantity !== null && Math.abs(billableQuantity - syncedQuantity) < 1e-9 ? row.syncStatus : "pending", ...legacy };
}
