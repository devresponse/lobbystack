import { and, asc, eq, sql } from "drizzle-orm";

import { billingAccounts, billingUsageEvents, billingUsageMonths, businesses, calls, enqueueOutbox, type DatabaseTransaction } from "@lobbystack/db";
import { billingErrorCodes, isBillingPlanSlug, liveSubscriptionStates, MAX_PHONE_CALL_MS, PHONE_RESERVATION_SLICE_SECONDS, type BillingPlanLimits, type BillingPlanSlug } from "@lobbystack/shared";

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
  usageComplete: boolean;
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
      const codePointLength = Array.from(body).length;
      return codePointLength <= 70 ? 1 : Math.max(1, Math.ceil(codePointLength / 67));
    }
  }
  return septets <= 160 ? 1 : Math.max(1, Math.ceil(septets / 153));
}

export function effectiveBillingPlan(input: { deploymentMode: string; accountPlan: string | null; subscriptionState: string | null }): BillingPlanSlug {
  if (input.deploymentMode !== "cloud") return "self_host";
  const paidState = (liveSubscriptionStates as readonly (string | null)[]).includes(input.subscriptionState);
  if (isBillingPlanSlug(input.accountPlan) && (input.accountPlan === "free_cloud" || paidState)) return input.accountPlan;
  return "free_cloud";
}

function includedQuantity(config: BillingPlanLimits, kind: NonAiBillingUsageKind): number | null {
  if (kind === "voice_seconds") return config.voiceSecondsIncluded;
  if (kind === "alert_sms_segments") return config.alertSmsSegmentsIncluded;
  if (kind === "chat_ai_tokens") return config.chatAiTokensIncluded;
  return config.outboundCallAttemptsIncluded;
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

type BillingContext = PlanInForce & { capCents: number | null; billingInterval: string | null };
// The business's plan with every plan's limits, which replaying the month needs.
type UsageContext = BillingContext & { limits: BillingPlanLimitBook };

// The limits of the plan in force.
function currentLimits(billing: Pick<UsageContext, "plan" | "planCode" | "limits">): BillingPlanLimits {
  return limitsFor(billing.limits, billing.plan, billing.planCode);
}

// Reservations, top-ups and corrections in a business's billing period run one at a time.
async function lockUsagePeriod(tx: DatabaseTransaction, businessId: string, periodKey: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing-usage:${businessId}:${periodKey}`}, 0))`);
}

// Self-host, and a paid plan with no overage cap, never run out of voice, so calls reserve nothing.
function hasUnlimitedVoice(billing: Pick<UsageContext, "plan" | "planCode" | "capCents" | "limits">): boolean {
  return billing.plan === "self_host" || (currentLimits(billing).overagesBillable && billing.capCents === null);
}

// The voice seconds a limited plan can still reserve: its included seconds
// left, plus what the overage cap still pays for, which is no limit when extra
// minutes cost nothing. 0 on an unlimited plan.
function reservableVoiceSeconds(billing: Pick<UsageContext, "plan" | "planCode" | "capCents" | "limits">, current: { usage: UsageCounts; rawSpendCents: number }): number {
  const config = currentLimits(billing);
  const included = includedQuantity(config, "voice_seconds");
  const remainingIncluded = included === null ? 0 : Math.max(0, included - current.usage.voice_seconds);
  const remainingCap = billing.capCents === null ? 0 : Math.max(0, billing.capCents - current.rawSpendCents);
  const rate = rateCents(config, "voice_seconds");
  const capSeconds = rate > 0 ? Math.floor(remainingCap / rate) : Number.POSITIVE_INFINITY;
  return config.overagesBillable ? (billing.capCents === null ? 0 : remainingIncluded + capSeconds) : remainingIncluded;
}

export async function loadBillingContext(tx: DatabaseTransaction, businessId: string): Promise<BillingContext> {
  const [business] = await tx.select({ deploymentMode: businesses.deploymentMode }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  const [account] = await tx.select({ plan: billingAccounts.plan, planCode: billingAccounts.planCode, subscriptionState: billingAccounts.subscriptionState, overageSpendingCapCents: billingAccounts.overageSpendingCapCents, billingInterval: billingAccounts.billingInterval }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId)).limit(1);
  const plan = effectiveBillingPlan({ deploymentMode: business?.deploymentMode ?? "cloud", accountPlan: account?.plan ?? null, subscriptionState: account?.subscriptionState ?? null });
  // A promo plan counts only while its subscription is live, so a lapsed one is Free like any other.
  const live = (liveSubscriptionStates as readonly (string | null)[]).includes(account?.subscriptionState ?? null);
  return {
    plan,
    planCode: live && plan === account?.plan ? account.planCode ?? null : null,
    capCents: account?.overageSpendingCapCents ?? null,
    billingInterval: account?.billingInterval ?? null,
  };
}

async function loadUsageContext(tx: DatabaseTransaction, businessId: string): Promise<UsageContext> {
  return { ...await loadBillingContext(tx, businessId), limits: await readBillingPlanLimitBook(tx) };
}

/** The business's effective plan, its promo plan when it has one, and the limits it enforces now. */
export async function loadBusinessPlanLimits(tx: DatabaseTransaction, businessId: string): Promise<PlanInForce & { limits: BillingPlanLimits }> {
  const billing = await loadUsageContext(tx, businessId);
  return { plan: billing.plan, planCode: billing.planCode, limits: currentLimits(billing) };
}

async function loadEvents(tx: DatabaseTransaction, businessId: string, periodKey: string): Promise<ReplayEvent[]> {
  return await tx.select({ sourceKey: billingUsageEvents.sourceKey, quantity: billingUsageEvents.quantity, usageKind: billingUsageEvents.usageKind, planAtRecordTime: billingUsageEvents.planAtRecordTime, planCodeAtRecordTime: billingUsageEvents.planCodeAtRecordTime, billingIntervalAtRecordTime: billingUsageEvents.billingIntervalAtRecordTime, createdAt: billingUsageEvents.createdAt, isFinal: billingUsageEvents.isFinal })
    .from(billingUsageEvents)
    .where(and(eq(billingUsageEvents.businessId, businessId), eq(billingUsageEvents.periodKey, periodKey)))
    .orderBy(asc(billingUsageEvents.createdAt));
}

// Annual plans send Polar each event's share of the month's overage once it is
// final. Only the other final events have been billed, so open reservations
// never count against this one. An event that was already final keeps what it
// billed and moves only by its own change.
export function billableQuantityForEvent(others: ReplayEvent[], event: ReplayEvent, current: PlanInForce, limits: BillingPlanLimitBook, billed?: { quantity: number; billableQuantity: number }): number {
  const plan = isBillingPlanSlug(event.planAtRecordTime) ? event.planAtRecordTime : current.plan;
  const included = includedQuantity(eventLimits(event, current, limits), event.usageKind as NonAiBillingUsageKind);
  if (event.billingIntervalAtRecordTime !== "annual" || (plan !== "starter" && plan !== "pro") || included === null) return Math.max(0, event.quantity);
  const before = others.reduce((sum, row) => (row.isFinal && row.usageKind === event.usageKind ? sum + Math.max(0, row.quantity) : sum), 0);
  const overage = (quantity: number) => Math.max(0, before + Math.max(0, quantity) - included);
  return billed ? Math.max(0, billed.billableQuantity + overage(event.quantity) - overage(billed.quantity)) : overage(event.quantity) - overage(0);
}

async function ensureUsageMonth(tx: DatabaseTransaction, businessId: string, periodKey: string, plan: BillingPlanSlug): Promise<void> {
  await tx.insert(billingUsageMonths).values({ businessId, periodKey, planAtSnapshot: plan }).onConflictDoNothing({ target: [billingUsageMonths.businessId, billingUsageMonths.periodKey] });
}

function usageStatusFrom(input: { periodKey: string; billing: UsageContext; events: ReplayEvent[] }): UsageStatus {
  const { events, billing } = input;
  const replay = replayEvents(events, billing, billing.limits);
  const config = currentLimits(billing);
  const overageSpendCents = Math.max(0, Math.ceil(replay.rawSpendCents - 1e-9));
  const capReached = billing.capCents !== null && replay.rawSpendCents > 0 && overageSpendCents >= billing.capCents;
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
    voiceBlocked: (!config.overagesBillable && config.voiceSecondsIncluded !== null && replay.usage.voice_seconds >= config.voiceSecondsIncluded) || capReached,
    alertSmsBlocked: (!config.overagesBillable && config.alertSmsSegmentsIncluded !== null && replay.usage.alert_sms_segments >= config.alertSmsSegmentsIncluded) || capReached,
    outboundCallAttemptsBlocked: (!config.overagesBillable && config.outboundCallAttemptsIncluded !== null && replay.usage.outbound_call_attempts >= config.outboundCallAttemptsIncluded) || capReached,
    chatAiBlocked: (!config.overagesBillable && config.chatAiTokensIncluded !== null && replay.usage.chat_ai_tokens >= config.chatAiTokensIncluded) || capReached,
    overageSpendCents,
    overageSpendingCapCents: billing.capCents,
    overageSpendingCapReached: capReached,
    usageComplete: events.every((event) => event.isFinal),
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
  const billing = await loadUsageContext(tx, input.businessId);
  const existing = (await tx.select({ id: billingUsageEvents.id, quantity: billingUsageEvents.quantity, syncStatus: billingUsageEvents.syncStatus }).from(billingUsageEvents).where(and(eq(billingUsageEvents.businessId, input.businessId), eq(billingUsageEvents.sourceKey, input.sourceKey))).limit(1))[0];
  if (existing && existing.quantity > 0) return { allowed: true, errorCode: null, usageEventId: existing.id, syncNeeded: existing.syncStatus === "pending", periodKey, plan: billing.plan, quantity: existing.quantity };
  const events = await loadEvents(tx, input.businessId, periodKey);
  const current = replayEvents(events, billing, billing.limits);
  let quantity = input.quantity;
  // A phone call reserves one slice and the worker tops it up as the call
  // runs, so concurrent calls share what remains.
  if (quantity === undefined && input.usageKind === "voice_seconds") quantity = Math.min(PHONE_RESERVATION_SLICE_SECONDS, reservableVoiceSeconds(billing, current));
  quantity = Math.max(0, quantity ?? 0);
  if (quantity <= 0) {
    if (input.usageKind === "voice_seconds" && hasUnlimitedVoice(billing)) return { allowed: true, errorCode: null, syncNeeded: false, periodKey, plan: billing.plan };
    const errorCode = input.usageKind === "voice_seconds" ? billingErrorCodes.voiceLimitReached : input.usageKind === "alert_sms_segments" ? billingErrorCodes.alertSmsLimitReached : input.usageKind === "chat_ai_tokens" ? billingErrorCodes.chatAiLimitReached : billingErrorCodes.outboundCallAttemptLimitReached;
    return { allowed: false, errorCode, syncNeeded: false, periodKey, plan: billing.plan };
  }
  const included = includedQuantity(currentLimits(billing), input.usageKind);
  if (!currentLimits(billing).overagesBillable && included !== null && current.usage[input.usageKind] + quantity > included) {
    const errorCode = input.usageKind === "voice_seconds" ? billingErrorCodes.voiceLimitReached : input.usageKind === "alert_sms_segments" ? billingErrorCodes.alertSmsLimitReached : input.usageKind === "chat_ai_tokens" ? billingErrorCodes.chatAiLimitReached : billingErrorCodes.outboundCallAttemptLimitReached;
    return { allowed: false, errorCode, syncNeeded: false, periodKey, plan: billing.plan };
  }
  const eventPayload = { sourceKey: input.sourceKey, quantity, usageKind: input.usageKind, planAtRecordTime: billing.plan, planCodeAtRecordTime: billing.planCode, billingIntervalAtRecordTime: billing.billingInterval, createdAt: recordedAt, isFinal: input.usageKind === "outbound_call_attempts" || input.usageKind === "chat_ai_tokens" };
  const simulated = replayEvents([...events, eventPayload], billing, billing.limits);
  if (billing.capCents !== null && simulated.rawSpendCents > billing.capCents) {
    const errorCode = input.usageKind === "voice_seconds" ? billingErrorCodes.voiceLimitReached : input.usageKind === "alert_sms_segments" ? billingErrorCodes.alertSmsLimitReached : input.usageKind === "chat_ai_tokens" ? billingErrorCodes.chatAiLimitReached : billingErrorCodes.outboundCallAttemptLimitReached;
    return { allowed: false, errorCode, syncNeeded: false, periodKey, plan: billing.plan };
  }
  const syncNeeded = billing.plan === "starter" || billing.plan === "pro";
  const others = events.filter((row) => row.sourceKey !== input.sourceKey);
  const billableQuantity = billableQuantityForEvent(others, eventPayload, billing, billing.limits);
  const [event] = existing
    ? await tx.update(billingUsageEvents).set({ quantity, billableQuantity, planAtRecordTime: billing.plan, planCodeAtRecordTime: billing.planCode, billingIntervalAtRecordTime: billing.billingInterval, isFinal: eventPayload.isFinal, syncStatus: syncNeeded ? "pending" : "skipped", updatedAt: new Date() }).where(eq(billingUsageEvents.id, existing.id)).returning({ id: billingUsageEvents.id })
    : await tx.insert(billingUsageEvents).values({ businessId: input.businessId, periodKey, sourceKey: input.sourceKey, usageKind: input.usageKind, quantity, billableQuantity, planAtRecordTime: billing.plan, planCodeAtRecordTime: billing.planCode, billingIntervalAtRecordTime: billing.billingInterval, isFinal: eventPayload.isFinal, syncStatus: syncNeeded ? "pending" : "skipped", createdAt: recordedAt, updatedAt: new Date() }).returning({ id: billingUsageEvents.id });
  if (!event) throw new Error("Billing usage event could not be recorded.");
  await refreshUsageMonth(tx, { businessId: input.businessId, periodKey, billing, events: [...others, eventPayload] });
  return { allowed: true, errorCode: null, usageEventId: event.id, syncNeeded, periodKey, plan: billing.plan, quantity };
}

/**
 * Grows a phone call's reservation while the call runs: by one slice, or by
 * what the plan has left, and never past MAX_PHONE_CALL_MS for the call.
 * Returns the seconds granted, 0 when the call has ended, is a browser call,
 * holds no reservation (an unlimited plan), or has nothing left to grow by.
 * Like the first reservation it queues no Polar sync: the call's finish
 * corrects the event to the real seconds and syncs those.
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
  // The replay already counts this call's reservation. A plan upgraded to
  // unlimited mid-call still grows it, up to the longest call.
  const free = hasUnlimitedVoice(billing) ? Number.POSITIVE_INFINITY : reservableVoiceSeconds(billing, replayEvents(events, billing, billing.limits));
  const granted = Math.min(PHONE_RESERVATION_SLICE_SECONDS, free, MAX_PHONE_CALL_MS / 1_000 - event.quantity);
  if (granted <= 0) return 0;
  const replayed = events.map((row) => (row === event ? { ...row, quantity: row.quantity + granted } : row));
  if (billing.capCents !== null && replayEvents(replayed, billing, billing.limits).rawSpendCents > billing.capCents) return 0;
  const billableQuantity = billableQuantityForEvent(events.filter((row) => row !== event), { ...event, quantity: event.quantity + granted }, billing, billing.limits);
  await tx.update(billingUsageEvents).set({ quantity: event.quantity + granted, billableQuantity, updatedAt: new Date() }).where(eq(billingUsageEvents.id, reservation.id));
  await refreshUsageMonth(tx, { businessId: input.businessId, periodKey: reservation.periodKey, billing, events: replayed });
  return granted;
}

export async function correctUsageInTransaction(tx: DatabaseTransaction, input: { businessId: string; sourceKey: string; usageKind: NonAiBillingUsageKind; quantity: number; recordedAt?: Date | undefined }): Promise<string> {
  const recordedAt = input.recordedAt ?? new Date();
  const existingBeforeLock = (await tx.select({ id: billingUsageEvents.id, periodKey: billingUsageEvents.periodKey }).from(billingUsageEvents).where(and(eq(billingUsageEvents.businessId, input.businessId), eq(billingUsageEvents.sourceKey, input.sourceKey))).limit(1))[0];
  const periodKey = existingBeforeLock?.periodKey ?? periodKeyFor(recordedAt);
  await lockUsagePeriod(tx, input.businessId, periodKey);
  const billing = await loadUsageContext(tx, input.businessId);
  const existing = (await tx.select({ id: billingUsageEvents.id, periodKey: billingUsageEvents.periodKey, planAtRecordTime: billingUsageEvents.planAtRecordTime, planCodeAtRecordTime: billingUsageEvents.planCodeAtRecordTime, billingIntervalAtRecordTime: billingUsageEvents.billingIntervalAtRecordTime, createdAt: billingUsageEvents.createdAt, quantity: billingUsageEvents.quantity, billableQuantity: billingUsageEvents.billableQuantity, isFinal: billingUsageEvents.isFinal }).from(billingUsageEvents).where(and(eq(billingUsageEvents.businessId, input.businessId), eq(billingUsageEvents.sourceKey, input.sourceKey))).limit(1))[0];
  let eventId: string;
  if (existing) {
    const events = await loadEvents(tx, input.businessId, periodKey);
    // A correction keeps the plan the usage was recorded under.
    const replacement: ReplayEvent = { sourceKey: input.sourceKey, quantity: Math.max(0, input.quantity), usageKind: input.usageKind, planAtRecordTime: existing.planAtRecordTime ?? billing.plan, planCodeAtRecordTime: existing.planAtRecordTime ? existing.planCodeAtRecordTime : billing.planCode, billingIntervalAtRecordTime: existing.billingIntervalAtRecordTime ?? billing.billingInterval, createdAt: existing.createdAt, isFinal: true };
    const billed = existing.isFinal ? { quantity: existing.quantity, billableQuantity: existing.billableQuantity ?? existing.quantity } : undefined;
    const billableQuantity = billableQuantityForEvent(events.filter((row) => row.sourceKey !== input.sourceKey), replacement, billing, billing.limits, billed);
    await tx.update(billingUsageEvents).set({ quantity: Math.max(0, input.quantity), billableQuantity, isFinal: true, syncStatus: billing.plan === "starter" || billing.plan === "pro" ? "pending" : "skipped", updatedAt: new Date() }).where(eq(billingUsageEvents.id, existing.id));
    eventId = existing.id;
  } else {
    const replacement: ReplayEvent = { sourceKey: input.sourceKey, quantity: Math.max(0, input.quantity), usageKind: input.usageKind, planAtRecordTime: billing.plan, planCodeAtRecordTime: billing.planCode, billingIntervalAtRecordTime: billing.billingInterval, createdAt: recordedAt, isFinal: true };
    const events = await loadEvents(tx, input.businessId, periodKey);
    const billableQuantity = billableQuantityForEvent(events, replacement, billing, billing.limits);
    const [event] = await tx.insert(billingUsageEvents).values({ businessId: input.businessId, periodKey, sourceKey: input.sourceKey, usageKind: input.usageKind, quantity: Math.max(0, input.quantity), billableQuantity, planAtRecordTime: billing.plan, planCodeAtRecordTime: billing.planCode, billingIntervalAtRecordTime: billing.billingInterval, isFinal: true, syncStatus: billing.plan === "starter" || billing.plan === "pro" ? "pending" : "skipped", createdAt: recordedAt, updatedAt: new Date() }).returning({ id: billingUsageEvents.id });
    if (!event) throw new Error("Billing usage correction could not be recorded.");
    eventId = event.id;
  }
  await refreshUsageMonth(tx, { businessId: input.businessId, periodKey, billing });
  return eventId;
}

/**
 * Queues a usage event's sync to Polar once it is final. A reservation's
 * estimate waits for the correction that settles it, which queues it then: a
 * sync queued earlier would be skipped, and its key would keep the settled
 * quantity from being queued when it matches the estimate.
 */
export async function enqueueUsageSyncInTransaction(tx: DatabaseTransaction, input: { businessId: string; usageEventId: string }): Promise<void> {
  const event = (await tx.select({ quantity: billingUsageEvents.quantity, syncStatus: billingUsageEvents.syncStatus, isFinal: billingUsageEvents.isFinal }).from(billingUsageEvents).where(and(eq(billingUsageEvents.id, input.usageEventId), eq(billingUsageEvents.businessId, input.businessId))).limit(1))[0];
  if (!event || event.syncStatus !== "pending" || !event.isFinal) return;
  await enqueueOutbox(tx, {
    topic: "billing.syncUsage",
    businessId: input.businessId,
    aggregateType: "billing_usage_event",
    aggregateId: input.usageEventId,
    dedupeKey: `billing-usage:${input.usageEventId}:sync:${event.quantity}`,
    payload: { usageEventId: input.usageEventId },
  });
}
