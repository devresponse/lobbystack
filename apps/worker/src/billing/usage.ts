// Sending usage to the billing provider, and the monthly unit economics.
import type { JobEnvelope } from "@lobbystack/contracts";
import { meterEventTime, priceUsage } from "@lobbystack/shared";
import { claimBillingUsageSync, confirmBillingUsageSync, loadBillingUsageEvent, loadStripeSelling, recordProductEvent } from "@lobbystack/domain";
import { refreshUnitEconomicsMonth } from "@lobbystack/domain";
import { getPostHogDistinctIdForBusinessSystem } from "@lobbystack/telemetry";
import type { JobResult, WorkerDependencies } from "../handlers";
import { businessIdOrThrow } from "../jobInput";
import { isMeteredUsageKind, overageKindOf } from "@lobbystack/providers/billing/usage";

/**
 * Stripe keeps a meter event's identifier for at least 24 hours, so a claimed
 * event goes out again only within 20 of its first send; after that it counts
 * as sent, and the daily totals check corrects the month if Stripe never had it.
 */
export const METER_RESEND_WITHIN_MS = 20 * 60 * 60_000;

/** billing.syncUsage: sends a usage row's next event to the billing provider (sendBillingUsageEvent). */
export async function syncBillingUsage(job: JobEnvelope, dependencies: WorkerDependencies): Promise<JobResult> {
  const usageEventId = String(job.payload.usageEventId ?? "");
  if (!dependencies.billing) return { status: "skipped", entityId: usageEventId };
  if (!usageEventId) return { status: "skipped" };
  return await sendBillingUsageEvent(dependencies, { businessId: businessIdOrThrow(job), usageEventId });
}

/**
 * Sends a usage row's next event to the billing provider: billing.syncUsage
 * for each final row, and billing.endPlanForPack for the rows still pending
 * before it ends a subscription a prepaid pack replaced. On a money meter
 * (Stripe) the event carries the row's price, from its rate as first claimed,
 * and is dated by the grace rule (meterEventTime). Stripe takes one event at
 * a time per customer and meter, and answers another with 429, which throws
 * so the job retries.
 */
export async function sendBillingUsageEvent(dependencies: WorkerDependencies, input: { businessId: string; usageEventId: string }): Promise<JobResult> {
  const { usageEventId } = input;
  const billing = dependencies.billing;
  if (!billing) return { status: "skipped", entityId: usageEventId };
  const event = await loadBillingUsageEvent(dependencies.domain, { businessId: input.businessId, usageEventId });
  if (!event) return { status: "skipped", entityId: usageEventId };
  if (event.syncStatus === "synced" || event.syncStatus === "succeeded") return { status: "completed", entityId: event.id };
  if (event.syncStatus === "skipped" || !event.customerId || !event.isFinal) return { status: "skipped", entityId: event.id };
  if (event.plan !== "starter" && event.plan !== "pro") return { status: "skipped", entityId: event.id };
  const usageKind = isMeteredUsageKind(event.usageKind) ? event.usageKind : undefined;
  if (!usageKind) return { status: "skipped", entityId: event.id };
  // The row's next event: its billable quantity first, then each correction's difference.
  const meterMoney = billing.can.meterMoney;
  const send = await claimBillingUsageSync(dependencies.domain, { businessId: event.businessId, usageEventId: event.id, ...(meterMoney ? { resendWithinMs: METER_RESEND_WITHIN_MS } : {}) });
  if (!send) return { status: "completed", entityId: event.id };
  const amountCents = meterMoney ? priceUsage(usageKind, send.quantity, send.rateCents ?? 0) : null;
  // Past Stripe's memory of its identifier, or nothing to bill (no rate): it counts as sent.
  if (send.expired || amountCents === 0) {
    await confirmBillingUsageSync(dependencies.domain, { businessId: event.businessId, usageEventId: event.id, seq: send.seq });
    return { status: "completed", entityId: event.id };
  }
  let occurredAt = event.createdAt;
  if (meterMoney) {
    const selling = await loadStripeSelling(dependencies.domain);
    // Overage on the plan subscription is invoiced at its renewal, not on the 1st.
    const period = selling.overage === "checkout" && event.periodStart && event.periodEnd ? { start: event.periodStart, end: event.periodEnd } : null;
    occurredAt = meterEventTime(event.createdAt, new Date(), selling.usageGraceHours, period);
  }
  try {
    await billing.reportUsage({
      customer: { id: event.customerId, billingKey: event.billingKey },
      businessId: event.businessId,
      kind: overageKindOf(usageKind),
      units: send.quantity,
      // Polar prices usage itself; a provider metering money gets the row's price.
      amountCents,
      occurredAt,
      identifier: send.externalId,
    });
  } catch (error) {
    // `ops.billing.usage_sync_recovered` is intentionally not emitted here.
    // `billing_usage_events.sync_status` only models pending/skipped/synced
    // (plus a legacy "succeeded" read), and `confirmBillingUsageSync`
    // transitions only from "pending", so there is no durable failure state
    // to recover from. Emitting a recovery event would require a persisted
    // failed marker (schema/state change), which is out of scope for this
    // phase and must not be fabricated.
    await recordBillingUsageSyncFailed(dependencies, { businessId: event.businessId });
    throw error;
  }
  await confirmBillingUsageSync(dependencies.domain, { businessId: event.businessId, usageEventId: event.id, seq: send.seq });
  return { status: "completed", entityId: event.id };
}

/** billing.refreshUnitEconomics: rebuilds a business's month of unit economics. */
export async function refreshBillingUnitEconomics(job: JobEnvelope, dependencies: WorkerDependencies): Promise<JobResult> {
  const businessId = businessIdOrThrow(job);
  const monthKey = typeof job.payload.monthKey === "string" ? job.payload.monthKey : undefined;
  const rollupId = await refreshUnitEconomicsMonth(dependencies.domain, { businessId, ...(monthKey ? { monthKey } : {}) });
  return { status: "completed", entityId: rollupId };
}

async function recordBillingUsageSyncFailed(
  dependencies: WorkerDependencies,
  input: { businessId: string },
): Promise<void> {
  try {
    await recordProductEvent(dependencies.domain, {
      name: "ops.billing.usage_sync_failed",
      businessId: input.businessId,
      distinctId: getPostHogDistinctIdForBusinessSystem(input.businessId),
      actorType: "worker",
      properties: { provider: dependencies.billing?.id ?? "polar" },
    });
  } catch {
    // Billing sync telemetry is best-effort and must not mask the provider error.
  }
}
