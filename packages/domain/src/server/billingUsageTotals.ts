import { and, eq, gt, isNotNull, sql } from "drizzle-orm";

import { billingAccounts, billingUsageEvents, billingUsageMonths, withBusinessTransaction } from "@lobbystack/db";
import { priceUsage, type PricedUsageKind } from "@lobbystack/shared";

import { readBillingCatalogSnapshot } from "./billingPlans";
import type { DomainContext } from "./context";

// The daily totals check (the Stripe plan's step 16) compares what LobbyStack
// confirmed sending to Stripe's money meters with what they hold, over the
// business's whole usage, so a correction one day is part of what the next
// day compares and never needs sending again at a month's turn. The worker's
// billing.checkUsageTotals asks Stripe and sends the corrections.

/** The overage kinds as the meters name them. */
export type UsageTotalsKind = "voice" | "alert_sms" | "transfer";

const kindOfUsage: Record<PricedUsageKind, UsageTotalsKind> = { voice_seconds: "voice", alert_sms_segments: "alert_sms", outbound_call_attempts: "transfer" };

/** No send, and no check, in this long, so Stripe has processed every event the comparison counts, a correction included. */
export const USAGE_TOTALS_QUIET_MS = 60 * 60_000;

export type UsageTotalsWork = {
  customerId: string;
  /** When the business's first priced usage happened: Stripe's meters are read from then. */
  since: Date;
  /** What LobbyStack confirmed sending, in cents by kind: each row's confirmed quantity at its rate. */
  confirmed: Record<UsageTotalsKind, number>;
  /** The month that numbers the corrections, and the number of its next correction. */
  periodKey: string;
  fixSeq: number;
  /** Where the open invoice period starts, which corrections go into: the month's 1st, or the plan's renewal when overage bills on the plan subscription. */
  openSince: Date;
  /** The live prices' currency, which a credit takes. */
  currency: string | null;
};

/**
 * What the check compares for one business, or why it waits: no Stripe
 * customer or nothing priced yet, an event claimed and not confirmed, or one
 * sent, or a check made, within the last hour, which Stripe may not have
 * counted yet.
 */
export async function loadUsageTotalsWork(context: DomainContext, input: { businessId: string; now: Date; overageOnPlan?: boolean }): Promise<UsageTotalsWork | { wait: "nothing" | "in_flight" | "recent" }> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const [account] = await tx.select({ source: billingAccounts.source, customerId: billingAccounts.customerId, periodStart: billingAccounts.currentPeriodStart }).from(billingAccounts).where(eq(billingAccounts.businessId, input.businessId)).limit(1);
    if (account?.source !== "stripe" || !account.customerId) return { wait: "nothing" as const };
    const of = eq(billingUsageEvents.businessId, input.businessId);
    const [inFlight] = await tx.select({ id: billingUsageEvents.id }).from(billingUsageEvents).where(and(of, isNotNull(billingUsageEvents.sendingQuantity))).limit(1);
    if (inFlight) return { wait: "in_flight" as const };
    const quietSince = new Date(input.now.getTime() - USAGE_TOTALS_QUIET_MS);
    const [recent] = await tx.select({ id: billingUsageEvents.id }).from(billingUsageEvents).where(and(of, gt(billingUsageEvents.syncSentAt, quietSince))).limit(1);
    if (recent) return { wait: "recent" as const };
    const periodKey = input.now.toISOString().slice(0, 7);
    const [month] = await tx.select({ fixSeq: billingUsageMonths.fixSeq, checkedAt: billingUsageMonths.providerCheckedAt }).from(billingUsageMonths).where(and(eq(billingUsageMonths.businessId, input.businessId), eq(billingUsageMonths.periodKey, periodKey))).limit(1);
    // A correction the last check sent may not be counted yet.
    if (month?.checkedAt && month.checkedAt > quietSince) return { wait: "recent" as const };
    const rows = await tx.select({ usageKind: billingUsageEvents.usageKind, synced: billingUsageEvents.syncedQuantity, rateCents: billingUsageEvents.rateCents, createdAt: billingUsageEvents.createdAt })
      .from(billingUsageEvents).where(and(of, isNotNull(billingUsageEvents.rateCents), isNotNull(billingUsageEvents.syncedQuantity)));
    const confirmed: Record<UsageTotalsKind, number> = { voice: 0, alert_sms: 0, transfer: 0 };
    let since: Date | null = null;
    for (const row of rows) {
      const kind = kindOfUsage[row.usageKind as PricedUsageKind];
      if (!kind || row.synced === null || row.rateCents === null) continue;
      confirmed[kind] += priceUsage(row.usageKind as PricedUsageKind, row.synced, row.rateCents);
      if (!since || row.createdAt < since) since = row.createdAt;
    }
    if (!since) return { wait: "nothing" as const };
    const catalog = await readBillingCatalogSnapshot(tx);
    const monthStart = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), 1));
    const openSince = input.overageOnPlan && account.periodStart && account.periodStart <= input.now ? account.periodStart : monthStart;
    return {
      customerId: account.customerId,
      since,
      confirmed: { voice: round(confirmed.voice), alert_sms: round(confirmed.alert_sms), transfer: round(confirmed.transfer) },
      periodKey,
      fixSeq: month?.fixSeq ?? 0,
      openSince,
      currency: catalog.prices.find((price) => !price.retired)?.currency ?? null,
    };
  }, { accessMode: "read only" });
}

const round = (cents: number) => Math.round(cents * 10_000) / 10_000;

/**
 * Keeps the check's result on the open month: what Stripe held for it after
 * the check's corrections, when it looked, and the number of the next
 * correction.
 */
export async function recordUsageTotalsCheck(context: DomainContext, input: { businessId: string; periodKey: string; providerOverageCents: number; fixSeq: number; checkedAt: Date }): Promise<void> {
  await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const fields = { providerOverageCents: input.providerOverageCents.toFixed(4), providerCheckedAt: input.checkedAt, fixSeq: sql`greatest(${billingUsageMonths.fixSeq}, ${input.fixSeq})`, updatedAt: input.checkedAt };
    await tx.insert(billingUsageMonths).values({ businessId: input.businessId, periodKey: input.periodKey, providerOverageCents: fields.providerOverageCents, providerCheckedAt: input.checkedAt, fixSeq: input.fixSeq })
      .onConflictDoUpdate({ target: [billingUsageMonths.businessId, billingUsageMonths.periodKey], set: fields });
  });
}
