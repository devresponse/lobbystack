import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { billingAccounts, billingUsageEvents, businessMemberships, businesses, createDatabaseClient, users, withBusinessTransaction } from "@lobbystack/db";
import { claimBillingUsageSync, confirmBillingUsageSync, correctAlertSmsUsage, getBillingUsageStatus, loadBusinessPlanLimits, loadUsageTotalsWork, reserveAlertSmsUsage, reserveOutboundCallAttempt, setOverageSpendingCap } from "@lobbystack/domain";
import { billingProviderOf, priceUsage } from "@lobbystack/shared";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// The checks run on accounts of the deployment's own provider. A Stripe account takes overage only with its
// overage subscription, so a paid one gets one; none gets a customer, so the worker never calls Stripe for them.
const provider = billingProviderOf(process.env);
const paidAccount = (businessId: string) => (provider === "stripe" ? { source: "stripe" as const, overageSubscriptionId: `sub_certoverage${businessId.replaceAll("-", "")}` } : {});

async function main(): Promise<void> {
  const migrator = createDatabaseClient("lobbystack_migrator");
  const worker = createDatabaseClient("lobbystack_worker");
  const app = createDatabaseClient("lobbystack_app");
  const businessId = randomUUID();
  const annualBusinessId = randomUUID();
  const concurrentBusinessId = randomUUID();
  // Stripe: an account without its overage subscription. Both providers: a priced usage row the totals check reads.
  const noOverageBusinessId = randomUUID();
  const pricedBusinessId = randomUUID();
  const userId = randomUUID();
  const unauthorizedUserId = randomUUID();
  try {
    await migrator.db.insert(users).values([{ id: userId, email: `${userId}@example.invalid`, normalizedEmail: `${userId}@example.invalid` }, { id: unauthorizedUserId, email: `${unauthorizedUserId}@example.invalid`, normalizedEmail: `${unauthorizedUserId}@example.invalid` }]);
    await migrator.db.insert(businesses).values([{ id: businessId, slug: `billing-${businessId}`, name: "Billing certification", timezone: "UTC", businessType: "test" }, { id: annualBusinessId, slug: `billing-${annualBusinessId}`, name: "Annual billing certification", timezone: "UTC", businessType: "test" }, { id: concurrentBusinessId, slug: `billing-${concurrentBusinessId}`, name: "Concurrent billing certification", timezone: "UTC", businessType: "test" }]);
    await migrator.db.insert(businessMemberships).values([{ businessId, userId, role: "business_owner" }, { businessId: annualBusinessId, userId, role: "business_owner" }, { businessId: concurrentBusinessId, userId, role: "business_owner" }]);
    await migrator.db.insert(billingAccounts).values([{ businessId, billingKey: `business:${businessId}`, plan: "starter", billingInterval: "monthly", subscriptionState: "active", ...paidAccount(businessId) }, { businessId: annualBusinessId, billingKey: `business:${annualBusinessId}`, plan: "starter", billingInterval: "annual", subscriptionState: "active", ...paidAccount(annualBusinessId) }, { businessId: concurrentBusinessId, billingKey: `business:${concurrentBusinessId}`, plan: "starter", billingInterval: "monthly", subscriptionState: "active", ...paidAccount(concurrentBusinessId) }]);

    const context = { db: worker.db };
    // The Starter terms the server enforces: an applied billing.json's, or this build's before an apply.
    const { limits: starter } = await withBusinessTransaction(worker.db, { businessId, actorType: "worker" }, async (tx) => await loadBusinessPlanLimits(tx, businessId));
    const sourceKey = `alert_sms:test:${businessId}:included`;
    const included = await reserveAlertSmsUsage(context, { businessId, sourceKey, estimatedSegments: 1 });
    const retry = await reserveAlertSmsUsage(context, { businessId, sourceKey, estimatedSegments: 1 });
    assert(included.allowed && retry.usageEventId === included.usageEventId, "Deterministic retry created a second usage reservation.");
    const duplicateCount = await migrator.db.select().from(billingUsageEvents).where(and(eq(billingUsageEvents.businessId, businessId), eq(billingUsageEvents.sourceKey, sourceKey)));
    assert(duplicateCount.length === 1, "Usage retry double-charged.");
    const transfer = await reserveOutboundCallAttempt(context, { businessId, sourceKey: `outbound_call:test:${businessId}` });
    assert(transfer.allowed, "Included transfer attempt was rejected.");

    const cap = await setOverageSpendingCap({ db: app.db }, { userId, businessId, capCents: 0 });
    assert(cap.overageSpendingCapCents === 0, "Zero-dollar overage cap was not persisted.");
    const overCap = await reserveAlertSmsUsage(context, { businessId, sourceKey: `alert_sms:test:${businessId}:over-cap`, estimatedSegments: (starter.alertSmsSegmentsIncluded ?? 0) + 1 });
    assert(!overCap.allowed && overCap.errorCode === "alert_sms_limit_reached", "Alert SMS reservation bypassed the shared zero-dollar cap.");
    let unauthorizedDenied = false;
    try { await setOverageSpendingCap({ db: app.db }, { userId: unauthorizedUserId, businessId, capCents: 100 }); } catch { unauthorizedDenied = true; }
    assert(unauthorizedDenied, "Non-admin user changed the overage cap.");
    await setOverageSpendingCap({ db: app.db }, { userId, businessId, capCents: null });
    const afterRemoval = await reserveAlertSmsUsage(context, { businessId, sourceKey: `alert_sms:test:${businessId}:cap-removed`, estimatedSegments: (starter.alertSmsSegmentsIncluded ?? 0) + 1 });
    assert(afterRemoval.allowed, "Removing the cap did not restore paid overage usage.");
    // A monthly plan reports only the overage to Polar too.
    const monthlyEvent = (await migrator.db.select().from(billingUsageEvents).where(eq(billingUsageEvents.id, afterRemoval.usageEventId!)).limit(1))[0];
    assert(monthlyEvent?.billingIntervalAtRecordTime === "monthly" && monthlyEvent.billableQuantity === 1, "Monthly-plan billable quantity was not isolated from included usage.");

    const planSource = `alert_sms:test:${businessId}:plan-snapshot`;
    await reserveAlertSmsUsage(context, { businessId, sourceKey: planSource, estimatedSegments: 1 });
    await migrator.db.update(billingAccounts).set({ plan: "pro" }).where(eq(billingAccounts.businessId, businessId));
    await correctAlertSmsUsage(context, { businessId, sourceKey: planSource, segments: 2 });
    const planEvent = (await migrator.db.select().from(billingUsageEvents).where(and(eq(billingUsageEvents.businessId, businessId), eq(billingUsageEvents.sourceKey, planSource))).limit(1))[0];
    assert(planEvent?.planAtRecordTime === "starter", "Usage correction lost plan-at-event pricing after a plan change.");

    const annualIncluded = starter.alertSmsSegmentsIncluded ?? 0;
    const annual = await reserveAlertSmsUsage(context, { businessId: annualBusinessId, sourceKey: `alert_sms:annual:${annualBusinessId}`, estimatedSegments: annualIncluded + 2 });
    assert(annual.allowed, "Annual-plan overage reservation was rejected.");
    const annualEvent = (await migrator.db.select().from(billingUsageEvents).where(eq(billingUsageEvents.id, annual.usageEventId!)).limit(1))[0];
    assert(annualEvent?.billingIntervalAtRecordTime === "annual" && annualEvent.billableQuantity === 2, "Annual-plan billable quantity was not isolated from included usage.");

    const concurrentIncluded = starter.alertSmsSegmentsIncluded ?? 0;
    await correctAlertSmsUsage(context, { businessId: concurrentBusinessId, sourceKey: `alert_sms:concurrent:${concurrentBusinessId}:included`, segments: concurrentIncluded });
    const perSegmentCents = starter.alertSmsOverageRatePerSegmentCents ?? 1;
    await setOverageSpendingCap({ db: app.db }, { userId, businessId: concurrentBusinessId, capCents: perSegmentCents });
    const concurrent = await Promise.all([
      reserveAlertSmsUsage(context, { businessId: concurrentBusinessId, sourceKey: `alert_sms:concurrent:${concurrentBusinessId}:a`, estimatedSegments: 1 }),
      reserveAlertSmsUsage(context, { businessId: concurrentBusinessId, sourceKey: `alert_sms:concurrent:${concurrentBusinessId}:b`, estimatedSegments: 1 }),
    ]);
    assert(concurrent.filter((result) => result.allowed).length === 1, "Concurrent reservations exceeded the shared spending cap.");

    // Stripe stops usage at the allowance until the business has its overage subscription, as before it's made or
    // after Stripe ended it unpaid; on Polar such an account takes overage as any other.
    await migrator.db.insert(businesses).values([{ id: noOverageBusinessId, slug: `billing-${noOverageBusinessId}`, name: "No-overage billing certification", timezone: "UTC", businessType: "test" }, { id: pricedBusinessId, slug: `billing-${pricedBusinessId}`, name: "Priced usage certification", timezone: "UTC", businessType: "test" }]);
    await migrator.db.insert(billingAccounts).values({ businessId: noOverageBusinessId, billingKey: `business:${noOverageBusinessId}`, source: provider, plan: "starter", billingInterval: "monthly", subscriptionState: "active" });
    const pastAllowance = await reserveAlertSmsUsage(context, { businessId: noOverageBusinessId, sourceKey: `alert_sms:test:${noOverageBusinessId}:past-allowance`, estimatedSegments: (starter.alertSmsSegmentsIncluded ?? 0) + 1 });
    if (provider === "stripe") assert(!pastAllowance.allowed && pastAllowance.errorCode === "alert_sms_limit_reached", "A Stripe account without its overage subscription took overage.");
    else assert(pastAllowance.allowed, "A Polar account was refused overage.");

    // A usage row is priced at its first claim, from the plan it counted under, and the daily totals check counts what
    // was confirmed sent at that price on Stripe, the only provider whose meters hold money. The row is written
    // straight to the table, with no job queued, so the worker never sends it; the account's customer exists nowhere.
    await migrator.db.insert(billingAccounts).values({ businessId: pricedBusinessId, billingKey: `business:${pricedBusinessId}`, source: provider, customerId: `cus_cert${pricedBusinessId.replaceAll("-", "")}`, plan: "starter", billingInterval: "monthly", subscriptionState: "active", ...paidAccount(pricedBusinessId) });
    const [priced] = await migrator.db.insert(billingUsageEvents).values({ businessId: pricedBusinessId, periodKey: new Date().toISOString().slice(0, 7), sourceKey: `voice:test:${pricedBusinessId}`, usageKind: "voice_seconds", quantity: 90, billableQuantity: 90, planAtRecordTime: "starter", billingIntervalAtRecordTime: "monthly", isFinal: true, syncStatus: "pending" }).returning({ id: billingUsageEvents.id });
    const claim = await claimBillingUsageSync(context, { businessId: pricedBusinessId, usageEventId: priced!.id });
    assert(claim && claim.quantity === 90 && claim.rateCents === (starter.voiceOverageRatePerMinuteCents ?? null), "A usage row wasn't priced at its plan's rate at its first claim.");
    await confirmBillingUsageSync(context, { businessId: pricedBusinessId, usageEventId: priced!.id, seq: claim.seq });
    const pricedRow = (await migrator.db.select({ rateCents: billingUsageEvents.rateCents, synced: billingUsageEvents.syncedQuantity }).from(billingUsageEvents).where(eq(billingUsageEvents.id, priced!.id)).limit(1))[0];
    assert(pricedRow?.rateCents === claim.rateCents && pricedRow.synced === 90, "A confirmed usage row lost its price or its quantity.");
    // An hour on, when nothing is in flight, as the daily check runs.
    const totals = await loadUsageTotalsWork(context, { businessId: pricedBusinessId, now: new Date(Date.now() + 2 * 60 * 60_000) });
    if (provider === "stripe") assert("confirmed" in totals && Math.abs(totals.confirmed.voice - priceUsage("voice_seconds", 90, claim.rateCents ?? 0)) < 0.0001, "The totals check didn't count the confirmed usage at its price.");
    else assert("wait" in totals && totals.wait === "nothing", "The totals check read a Polar business, whose meters hold no money.");

    const status = await getBillingUsageStatus(context, { businessId });
    assert(status.usageComplete === false && status.overageSpendingCapCents === null, "Billing status did not expose completeness or cap removal.");
    console.log(JSON.stringify({ billingProvider: provider, overageNeedsItsSubscription: provider === "stripe", usagePricedAtFirstClaim: true, providerTotalsChecked: provider === "stripe", multiKindMetering: true, zeroDollarCap: true, annualAccounting: true, monthlyAccounting: true, planSnapshotPreserved: true, concurrentReservationsSerialized: true, unauthorizedChangeDenied: true, retriesIdempotent: true, capRemovalRestoredOverages: true, completenessReported: true }));
  } finally {
    for (const id of [businessId, annualBusinessId, concurrentBusinessId, noOverageBusinessId, pricedBusinessId]) await migrator.db.delete(businesses).where(eq(businesses.id, id)).catch(() => undefined);
    await migrator.db.delete(users).where(eq(users.id, userId)).catch(() => undefined);
    await migrator.db.delete(users).where(eq(users.id, unauthorizedUserId)).catch(() => undefined);
    await Promise.all([migrator.pool.end(), worker.pool.end(), app.pool.end()]);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
