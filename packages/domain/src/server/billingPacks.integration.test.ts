import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { billingAccounts, billingPackDraws, billingPackPlans, billingPacks, billingUsageEvents, businesses, createDatabaseClient, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { correctAlertSmsUsage, getBillingUsageStatus, reserveAlertSmsUsage } from "./billing";
import { applyPackRefundInTransaction, closePackDisputeInTransaction, expirePackInTransaction, freezePackInTransaction, replaceLivePacksInTransaction } from "./billingPacks";
import { extendLiveCallReservation, finishLiveCall, startLivePhoneCall } from "./liveCalls";
import { correctUsageInTransaction, loadBusinessPlanLimits, periodKeyFor } from "./usage";

// The prepaid pack ledger against PostgreSQL: what a business with a pack
// may use, how its calls draw on the packs, and what refunds, disputes and
// end dates do to them. Businesses without a pack are covered by the live
// call and billing tests, which these changes must leave as they were.

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Prepaid pack integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

const DAY = 86_400_000;

async function rollbackTest(run: (tx: DatabaseTransaction) => Promise<void>) {
  const rollback = new Error("rollback test fixture");
  try {
    await client!.db.transaction(async (tx) => {
      await run(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

// Runs the call path as the worker runtime role, the way the admin webhook does.
async function asWorker<T>(tx: DatabaseTransaction, run: (context: { db: Database }) => Promise<T>): Promise<T> {
  await tx.execute(sql`set local role lobbystack_worker`);
  const result = await run({ db: tx as unknown as Database });
  await tx.execute(sql`reset role`);
  return result;
}

/** Runs one step in the business's own transaction as the worker, as the billing jobs do. */
async function inBusiness<T>(tx: DatabaseTransaction, businessId: string, run: (scoped: DatabaseTransaction) => Promise<T>): Promise<T> {
  return await asWorker(tx, (context) => withBusinessTransaction(context.db, { businessId, actorType: "worker" }, run));
}

async function business(tx: DatabaseTransaction, input: { plan?: "free_cloud" | "starter"; allowancesSince?: Date } = {}) {
  const businessId = randomUUID();
  await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "Prepaid pack test", timezone: "UTC", businessType: "test", telemetryEnabled: false });
  await tx.insert(billingAccounts).values({ businessId, billingKey: `test:${businessId}`, plan: input.plan ?? "free_cloud", subscriptionState: input.plan === "starter" ? "active" : null, billingInterval: input.plan === "starter" ? "month" : null, subscriptionId: input.plan === "starter" ? `sub_${businessId}` : null, allowancesSince: input.allowancesSince ?? null });
  return businessId;
}

async function packPlan(tx: DatabaseTransaction) {
  await tx.insert(billingPackPlans).values({ code: "pack_test", status: "active", names: { en: "Test pack", fr: "Test pack", es: "Test pack", sr: "Test pack" }, voiceSec: 15_000, days: 90, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, termsHash: "0".repeat(64) }).onConflictDoNothing();
}

/** A pack bought `paidDaysAgo` days ago that lasts `days`, null for one that never ends. */
async function pack(tx: DatabaseTransaction, businessId: string, input: { seconds: number; days?: number | null; paidDaysAgo?: number; amountCents?: number }) {
  await packPlan(tx);
  const days = input.days === undefined ? 90 : input.days;
  const paidAt = new Date(Date.now() - (input.paidDaysAgo ?? 1) * DAY);
  const ref = `pi_${randomUUID()}`;
  const [row] = await tx.insert(billingPacks).values({ businessId, pack: "pack_test", days, provider: "stripe", providerRef: ref, amountCents: input.amountCents ?? 10_000, currency: "cad", secondsTotal: input.seconds, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, paidAt, endsAt: days === null ? null : new Date(paidAt.getTime() + days * DAY) }).returning({ id: billingPacks.id });
  return { id: row!.id, ref };
}

async function packRow(tx: DatabaseTransaction, id: string) {
  const [row] = await tx.select({ status: billingPacks.status, secondsUsed: billingPacks.secondsUsed, refundedCents: billingPacks.refundedCents, unusedSeconds: billingPacks.unusedSeconds, endedAt: billingPacks.endedAt }).from(billingPacks).where(eq(billingPacks.id, id));
  return row!;
}

async function draws(tx: DatabaseTransaction, callId: string) {
  const rows = await tx.select({ packId: billingPackDraws.packId, seconds: billingPackDraws.seconds }).from(billingPackDraws).where(eq(billingPackDraws.sourceKey, `voice:${callId}`));
  return Object.fromEntries(rows.map((row) => [row.packId, row.seconds]));
}

const call = (businessId: string, from: string) => ({ businessId, sessionId: `live_${randomUUID()}`, from, to: "+15815550100" });

/** What the number claims, which run it as the owner, count for the business. */
async function includedNumbers(tx: DatabaseTransaction, businessId: string): Promise<number | null> {
  await tx.execute(sql`reset role`);
  const [row] = (await tx.execute<{ n: number | null }>(sql`select app.business_included_numbers(${businessId}::uuid) as n`)).rows;
  return row?.n ?? null;
}

describe.skipIf(!testUrl)("prepaid packs against PostgreSQL", () => {
  it("puts a business that would be on Free on the prepaid tier while a pack has time left, with the pack's seconds and allowances", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      expect(await includedNumbers(tx, businessId)).toBe(0);
      await pack(tx, businessId, { seconds: 3_000 });
      const status = await asWorker(tx, (context) => getBillingUsageStatus(context, { businessId }));
      expect(status).toMatchObject({ plan: "prepaid", voiceSecondsIncluded: null, voiceSecondsLeft: 3_000, voiceBlocked: false, alertSmsSegmentsIncluded: 50, outboundCallAttemptsIncluded: 20, chatAiTokensIncluded: 50, overagesBillable: false, pack: { secondsTotal: 3_000, secondsUsed: 0, secondsLeft: 3_000 } });
      const limits = await inBusiness(tx, businessId, (scoped) => loadBusinessPlanLimits(scoped, businessId));
      expect(limits.limits).toMatchObject({ knowledgeStorageBytes: 20 * 1_048_576, includedBusinessNumbers: 1, includedReceptionists: 1 });
      // The number claims count the pack's number as the limits do.
      expect(await includedNumbers(tx, businessId)).toBe(1);
    });
  });

  it("draws each call's slices from the pack that ends first, gives back what a finished call didn't use, and refuses a call once the packs are empty", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const soon = await pack(tx, businessId, { seconds: 400, days: 10 });
      const later = await pack(tx, businessId, { seconds: 1_000, days: 60 });
      const [first, second] = await asWorker(tx, async (context) => [await startLivePhoneCall(context, call(businessId, "+14165550134")), await startLivePhoneCall(context, call(businessId, "+14165550135"))]);
      expect([first!.maxDurationMs, second!.maxDurationMs]).toEqual([300_000, 300_000]);
      expect(await draws(tx, first!.callId)).toEqual({ [soon.id]: 300 });
      // The first pack had 100 seconds left; the rest comes from the next.
      expect(await draws(tx, second!.callId)).toEqual({ [soon.id]: 100, [later.id]: 200 });
      await expect(asWorker(tx, (context) => extendLiveCallReservation(context, { businessId, callId: first!.callId }))).resolves.toBe(300);
      expect(await draws(tx, first!.callId)).toEqual({ [soon.id]: 300, [later.id]: 300 });

      // The second call used 120 of its 300 seconds: the 180 go back to the pack drawn on last.
      await asWorker(tx, (context) => finishLiveCall(context, { businessId, callId: second!.callId, seconds: 120, end: "caller_hung_up" }));
      expect(await draws(tx, second!.callId)).toEqual({ [soon.id]: 100, [later.id]: 20 });
      expect((await packRow(tx, soon.id)).secondsUsed).toBe(400);
      expect((await packRow(tx, later.id)).secondsUsed).toBe(320);

      // 680 seconds left: two more slices and what remains, then nothing.
      const grants = await asWorker(tx, async (context) => {
        const result: number[] = [];
        for (let ask = 0; ask < 4; ask += 1) result.push(await extendLiveCallReservation(context, { businessId, callId: first!.callId }));
        return result;
      });
      expect(grants).toEqual([300, 300, 80, 0]);
      const status = await asWorker(tx, (context) => getBillingUsageStatus(context, { businessId }));
      expect(status).toMatchObject({ plan: "prepaid", voiceSecondsLeft: 0, voiceBlocked: true, pack: { secondsTotal: 1_400, secondsUsed: 1_400, secondsLeft: 0 } });
      // An empty pack still holds the prepaid tier: the caller hears busy, as on Free.
      await expect(asWorker(tx, (context) => startLivePhoneCall(context, call(businessId, "+14165550136")))).rejects.toMatchObject({ code: "voice_limit_reached" });
      // The finish settles the seconds the call really took, never more than the packs gave.
      await asWorker(tx, (context) => finishLiveCall(context, { businessId, callId: first!.callId, seconds: 1_200, end: "caller_hung_up" }));
      const [usage] = await tx.select({ planAtRecordTime: billingUsageEvents.planAtRecordTime, syncStatus: billingUsageEvents.syncStatus, quantity: billingUsageEvents.quantity }).from(billingUsageEvents).where(eq(billingUsageEvents.sourceKey, `voice:${first!.callId}`));
      expect(usage).toEqual({ planAtRecordTime: "prepaid", syncStatus: "skipped", quantity: 1_200 });
      expect(Object.values(await draws(tx, first!.callId)).reduce((sum, seconds) => sum + seconds, 0)).toBe(1_200);
    });
  });

  it("stops growing a call made on a pack once the pack ends, and puts the business back on Free", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const bought = await pack(tx, businessId, { seconds: 3_000 });
      const started = await asWorker(tx, (context) => startLivePhoneCall(context, call(businessId, "+14165550134")));
      await tx.update(billingPacks).set({ endsAt: new Date(Date.now() - 1_000) }).where(eq(billingPacks.id, bought.id));
      await expect(asWorker(tx, (context) => extendLiveCallReservation(context, { businessId, callId: started.callId }))).resolves.toBe(0);
      expect((await asWorker(tx, (context) => getBillingUsageStatus(context, { businessId }))).plan).toBe("free_cloud");
      expect(await includedNumbers(tx, businessId)).toBe(0);
      // The expiry keeps the seconds the pack still held for the accounts.
      const ended = await inBusiness(tx, businessId, (scoped) => expirePackInTransaction(scoped, { businessId, packId: bought.id }));
      expect(ended).toMatchObject({ status: "expired", previous: "active" });
      expect(await packRow(tx, bought.id)).toMatchObject({ status: "expired", secondsUsed: 300, unusedSeconds: 2_700 });
      // A finish after the end still gives the unused seconds back to the ended pack's accounts.
      await asWorker(tx, (context) => finishLiveCall(context, { businessId, callId: started.callId, seconds: 100, end: "caller_hung_up" }));
      expect(await packRow(tx, bought.id)).toMatchObject({ status: "expired", secondsUsed: 100, unusedSeconds: 2_900 });
    });
  });

  it("takes a partial refund's share of the seconds off a pack, and ends it on a refund of the whole payment", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const bought = await pack(tx, businessId, { seconds: 3_000, amountCents: 10_000 });
      const refund = (refundedCents: number) => inBusiness(tx, businessId, (scoped) => applyPackRefundInTransaction(scoped, { businessId, provider: "stripe", providerRef: bought.ref, refundedCents, at: new Date() }));
      await expect(refund(2_500)).resolves.toMatchObject({ status: "active" });
      expect((await asWorker(tx, (context) => getBillingUsageStatus(context, { businessId }))).pack).toMatchObject({ secondsTotal: 2_250, secondsLeft: 2_250 });
      // The same refund delivered again takes nothing more off.
      await refund(2_500);
      expect((await packRow(tx, bought.id)).refundedCents).toBe(2_500);
      await expect(refund(10_000)).resolves.toMatchObject({ status: "refunded", previous: "active" });
      expect(await packRow(tx, bought.id)).toMatchObject({ status: "refunded", refundedCents: 10_000, unusedSeconds: 0 });
      expect((await asWorker(tx, (context) => getBillingUsageStatus(context, { businessId }))).plan).toBe("free_cloud");
      // A refund of a payment no pack has changes nothing.
      await expect(inBusiness(tx, businessId, (scoped) => applyPackRefundInTransaction(scoped, { businessId, provider: "stripe", providerRef: "pi_unknown", refundedCents: 1, at: new Date() }))).resolves.toBeNull();
    });
  });

  it("freezes a disputed pack until the dispute closes: won, it counts again; lost, it ends refunded", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const disputed = await pack(tx, businessId, { seconds: 3_000 });
      const freeze = () => inBusiness(tx, businessId, (scoped) => freezePackInTransaction(scoped, { businessId, provider: "stripe", providerRef: disputed.ref }));
      const close = (won: boolean) => inBusiness(tx, businessId, (scoped) => closePackDisputeInTransaction(scoped, { businessId, provider: "stripe", providerRef: disputed.ref, won, at: new Date() }));
      await expect(freeze()).resolves.toMatchObject({ status: "frozen", previous: "active" });
      expect((await asWorker(tx, (context) => getBillingUsageStatus(context, { businessId }))).plan).toBe("free_cloud");
      await expect(close(true)).resolves.toMatchObject({ status: "active", previous: "frozen" });
      expect((await asWorker(tx, (context) => getBillingUsageStatus(context, { businessId }))).plan).toBe("prepaid");
      await freeze();
      await expect(close(false)).resolves.toMatchObject({ status: "refunded", previous: "frozen" });
      expect(await packRow(tx, disputed.id)).toMatchObject({ status: "refunded", refundedCents: 10_000 });
    });
  });

  it("starts the month's texts, transfers and chats afresh at a switch to a pack and again when it ends", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      // Free's 10 texts are used up before the pack.
      await tx.insert(billingUsageEvents).values({ businessId, periodKey: periodKeyFor(), sourceKey: `alert_sms:seed:${businessId}`, usageKind: "alert_sms_segments", quantity: 10, planAtRecordTime: "free_cloud", isFinal: true, syncStatus: "skipped", createdAt: new Date(Date.now() - 60_000) });
      const text = () => asWorker(tx, (context) => reserveAlertSmsUsage(context, { businessId, sourceKey: `alert_sms:test:${randomUUID()}`, estimatedSegments: 30 }));
      expect((await text()).allowed).toBe(false);
      const bought = await pack(tx, businessId, { seconds: 3_000 });
      await tx.update(billingAccounts).set({ allowancesSince: new Date(Date.now() - 1_000) }).where(eq(billingAccounts.businessId, businessId));
      // The pack gives 50 a month, counted from the switch.
      expect((await text()).allowed).toBe(true);
      expect((await text()).allowed).toBe(false);
      expect((await asWorker(tx, (context) => getBillingUsageStatus(context, { businessId }))).alertSmsSegmentsUsed).toBe(30);
      // Back on Free once the pack ends, the allowances start afresh again: neither the pack's
      // texts nor those from before it count against Free's.
      await tx.update(billingPacks).set({ endsAt: new Date(Date.now() - 500) }).where(eq(billingPacks.id, bought.id));
      expect((await asWorker(tx, (context) => getBillingUsageStatus(context, { businessId }))).alertSmsSegmentsUsed).toBe(0);
    });
  });

  it("lets a call that began on Free run on Free's terms after a pack is bought mid-call, without drawing on the pack", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const started = await asWorker(tx, (context) => startLivePhoneCall(context, call(businessId, "+14165550134")));
      const bought = await pack(tx, businessId, { seconds: 3_000 });
      await tx.update(billingAccounts).set({ allowancesSince: new Date() }).where(eq(billingAccounts.businessId, businessId));
      await expect(asWorker(tx, (context) => extendLiveCallReservation(context, { businessId, callId: started.callId }))).resolves.toBe(300);
      expect(await draws(tx, started.callId)).toEqual({});
      expect((await packRow(tx, bought.id)).secondsUsed).toBe(0);
      // A new call is the pack's.
      const next = await asWorker(tx, (context) => startLivePhoneCall(context, call(businessId, "+14165550135")));
      expect(await draws(tx, next.callId)).toEqual({ [bought.id]: 300 });
    });
  });

  it("keeps a Starter row's late correction going to the provider after a pack replaced the subscription", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx, { plan: "starter" });
      const sourceKey = `alert_sms:test:${randomUUID()}`;
      const reserved = await asWorker(tx, (context) => reserveAlertSmsUsage(context, { businessId, sourceKey, estimatedSegments: 1 }));
      expect(reserved).toMatchObject({ allowed: true, plan: "starter" });
      // The pack replaces the subscription, which counts as ended while the provider confirms it.
      await pack(tx, businessId, { seconds: 3_000 });
      await tx.update(billingAccounts).set({ replacedSubscriptionId: `sub_${businessId}`, allowancesSince: new Date() }).where(eq(billingAccounts.businessId, businessId));
      expect((await asWorker(tx, (context) => getBillingUsageStatus(context, { businessId }))).plan).toBe("prepaid");
      expect(await includedNumbers(tx, businessId)).toBe(1);
      await asWorker(tx, (context) => correctAlertSmsUsage(context, { businessId, sourceKey, segments: 2 }));
      const [row] = await tx.select({ planAtRecordTime: billingUsageEvents.planAtRecordTime, syncStatus: billingUsageEvents.syncStatus, quantity: billingUsageEvents.quantity }).from(billingUsageEvents).where(and(eq(billingUsageEvents.businessId, businessId), eq(billingUsageEvents.sourceKey, sourceKey)));
      expect(row).toEqual({ planAtRecordTime: "starter", syncStatus: "pending", quantity: 2 });
      // A pack's own row never goes to the provider.
      const packText = `alert_sms:test:${randomUUID()}`;
      await inBusiness(tx, businessId, (scoped) => correctUsageInTransaction(scoped, { businessId, sourceKey: packText, usageKind: "alert_sms_segments", quantity: 1 }));
      const [own] = await tx.select({ planAtRecordTime: billingUsageEvents.planAtRecordTime, syncStatus: billingUsageEvents.syncStatus }).from(billingUsageEvents).where(eq(billingUsageEvents.sourceKey, packText));
      expect(own).toEqual({ planAtRecordTime: "prepaid", syncStatus: "skipped" });
    });
  });

  it("ends every live pack when a subscription starts, keeping their unused seconds for the accounts", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const live = await pack(tx, businessId, { seconds: 3_000 });
      const forever = await pack(tx, businessId, { seconds: 600, days: null });
      const over = await pack(tx, businessId, { seconds: 600, days: 1, paidDaysAgo: 2 });
      const replaced = await inBusiness(tx, businessId, (scoped) => replaceLivePacksInTransaction(scoped, { businessId, at: new Date() }));
      expect(replaced.sort()).toEqual([live.id, forever.id].sort());
      expect(await packRow(tx, live.id)).toMatchObject({ status: "replaced", unusedSeconds: 3_000 });
      // A pack whose end already came is left to the expiry job.
      expect((await packRow(tx, over.id)).status).toBe("active");
      expect((await asWorker(tx, (context) => getBillingUsageStatus(context, { businessId }))).plan).toBe("free_cloud");
    });
  });
});
