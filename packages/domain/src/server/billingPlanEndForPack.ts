import { and, asc, count, eq, inArray, lte, sql } from "drizzle-orm";

import { billingAccounts, billingUsageEvents, withBusinessTransaction } from "@lobbystack/db";

import type { DomainContext } from "./context";

// What billing.endPlanForPack reads (decision 6, subscription to pack). A pack
// payment that found a live monthly Starter or Pro subscription marked it
// replaced (billing_accounts.replaced_subscription_id) and queued the job,
// which ends that subscription at the provider. Usage sent after the end
// reaches the provider's meters but is never invoiced, so the job first sends
// the Starter and Pro usage still pending and waits for calls that began on
// the old plan. This read gives it all of that, as the worker, writing
// nothing: the provider's own webhook moves the account once the end lands.

/** The usage overage bills, which the billing sweep sends too (migration 0146). */
const meteredUsageKinds = ["voice_seconds", "alert_sms_segments", "outbound_call_attempts"];

/** What billing.endPlanForPack needs to end a subscription a prepaid pack replaced. */
export type PlanEndForPackWork = {
  /** The subscription is still the account's own; false once the business subscribed again after the pack. */
  current: boolean;
  /** The account's overage subscription (Stripe), billing interval, state and period's end; null unless current, since they then describe the newer subscription. */
  overageSubscriptionId: string | null;
  billingInterval: string | null;
  subscriptionState: string | null;
  periodEnd: Date | null;
  /** When the pack replaced it: the job's own time when it parses, else the account's allowances_since. */
  switchedAt: Date | null;
  /** The business's final Starter and Pro usage rows still to send, oldest first; a newer subscription's rows go early, which changes nothing. */
  pendingUsage: string[];
  /** Starter and Pro rows not final yet that began by switchedAt: calls still running and text estimates. */
  unsettled: number;
};

/** A time the job's payload carries, or null when it carries none that parses. */
function parsedTime(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The work for ending subscriptionId at the provider, or null unless the
 * account names it as the subscription a pack replaced, whether or not it is
 * still the account's subscription. since is the switch's time from the job's
 * payload, which a later switch can't move as it moves allowances_since; now
 * stands in for it when neither is known.
 */
export async function loadPlanEndForPackWork(context: DomainContext, input: { businessId: string; subscriptionId: string; since?: Date | string | null; now?: Date }): Promise<PlanEndForPackWork | null> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const [account] = await tx.select({
      subscriptionId: billingAccounts.subscriptionId,
      replacedSubscriptionId: billingAccounts.replacedSubscriptionId,
      overageSubscriptionId: billingAccounts.overageSubscriptionId,
      billingInterval: billingAccounts.billingInterval,
      subscriptionState: billingAccounts.subscriptionState,
      periodEnd: billingAccounts.currentPeriodEnd,
      allowancesSince: billingAccounts.allowancesSince,
    }).from(billingAccounts).where(eq(billingAccounts.businessId, input.businessId)).limit(1);
    if (!account || account.replacedSubscriptionId !== input.subscriptionId) return null;
    const current = account.subscriptionId === input.subscriptionId;
    const switchedAt = parsedTime(input.since) ?? account.allowancesSince;
    // A row with no plan of its own counted under the account's, as the usage sync reads it.
    const starterOrPro = and(
      eq(billingUsageEvents.businessId, input.businessId),
      inArray(billingUsageEvents.usageKind, meteredUsageKinds),
      inArray(sql`coalesce(${billingUsageEvents.planAtRecordTime}, ${billingAccounts.plan})`, ["starter", "pro"]),
    );
    const pending = await tx.select({ id: billingUsageEvents.id }).from(billingUsageEvents)
      .innerJoin(billingAccounts, eq(billingAccounts.businessId, billingUsageEvents.businessId))
      .where(and(starterOrPro, eq(billingUsageEvents.syncStatus, "pending"), eq(billingUsageEvents.isFinal, true)))
      .orderBy(asc(billingUsageEvents.createdAt), asc(billingUsageEvents.id));
    const [open] = await tx.select({ unsettled: count() }).from(billingUsageEvents)
      .innerJoin(billingAccounts, eq(billingAccounts.businessId, billingUsageEvents.businessId))
      .where(and(starterOrPro, eq(billingUsageEvents.isFinal, false), lte(billingUsageEvents.createdAt, switchedAt ?? input.now ?? new Date())));
    return {
      current,
      overageSubscriptionId: current ? account.overageSubscriptionId : null,
      billingInterval: current ? account.billingInterval : null,
      subscriptionState: current ? account.subscriptionState : null,
      periodEnd: current ? account.periodEnd : null,
      switchedAt,
      pendingUsage: pending.map((row) => row.id),
      unsettled: Number(open?.unsettled ?? 0),
    };
  }, { accessMode: "read only" });
}
