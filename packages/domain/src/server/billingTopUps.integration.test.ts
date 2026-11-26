import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { billingAccounts, billingCodes, billingPackPlans, billingPacks, billingTopUpDraws, billingTopUps, billingUsageEvents, businesses, createDatabaseClient, users, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { correctAlertSmsUsage, getBillingUsageStatus, getWidgetChatAllowance, reserveAlertSmsUsage, reserveOutboundCallAttempt, reserveWidgetChatUsageInTransaction } from "./billing";
import { findBillingCodeOffer } from "./billingCodes";
import { grantTopUpInTransaction, listBusinessTopUps, redeemTopUpCodeInTransaction, revokeTopUpInTransaction, topUpCodeView, TopUpIdempotencyConflict } from "./billingTopUps";
import { extendLiveCallReservation, finishLiveCall, startLivePhoneCall } from "./liveCalls";
import { createBusiness } from "./tenancy";
import { correctUsageInTransaction, periodKeyFor } from "./usage";

// Top-ups against PostgreSQL (docs/features/top-ups.md): what a business with
// one may use on each plan, how its calls, texts, transfers and chats draw on
// it once the plan's own allowance is used up, what is billed, and how a
// top-up code is added once per business and per person. Businesses without a
// top-up are covered by the live call, billing and pack tests, which these
// changes must leave as they were.

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Top-up integration tests require a dedicated local test database.");
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

/** Runs one step in the business's own transaction as the worker, as the API and the billing jobs do. */
async function inBusiness<T>(tx: DatabaseTransaction, businessId: string, run: (scoped: DatabaseTransaction) => Promise<T>): Promise<T> {
  return await asWorker(tx, (context) => withBusinessTransaction(context.db, { businessId, actorType: "worker" }, run));
}

/** Runs one step as someone on the team in the dashboard: the app role, with the person and the business. */
async function asPerson<T>(tx: DatabaseTransaction, input: { userId: string; businessId: string }, run: (scoped: DatabaseTransaction) => Promise<T>): Promise<T> {
  await tx.execute(sql`set local role lobbystack_app`);
  const result = await withBusinessTransaction(tx as unknown as Database, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, run);
  await tx.execute(sql`reset role`);
  return result;
}

async function business(tx: DatabaseTransaction, input: { plan?: "free_cloud" | "starter"; capCents?: number | null } = {}) {
  const businessId = randomUUID();
  const starter = input.plan === "starter";
  await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "Top-up test", timezone: "UTC", businessType: "test", telemetryEnabled: false });
  await tx.insert(billingAccounts).values({ businessId, billingKey: `test:${businessId}`, plan: input.plan ?? "free_cloud", subscriptionState: starter ? "active" : null, billingInterval: starter ? "monthly" : null, subscriptionId: starter ? `sub_${businessId}` : null, overageSpendingCapCents: input.capCents ?? null });
  return businessId;
}

/** A business and its owner's account, made as the dashboard makes them. */
async function ownedBusiness(tx: DatabaseTransaction, label: string): Promise<{ userId: string; businessId: string }> {
  const userId = await person(tx, label);
  await tx.execute(sql`set local role lobbystack_app`);
  const { businessId } = await createBusiness({ db: tx as unknown as Database }, { userId, name: `Top-up ${label}`, timezone: "UTC", businessType: "test" });
  await tx.execute(sql`reset role`);
  return { userId, businessId };
}

async function person(tx: DatabaseTransaction, label: string): Promise<string> {
  const userId = randomUUID();
  const email = `top-up-${label}-${userId}@example.invalid`;
  await tx.insert(users).values({ id: userId, email, normalizedEmail: email, name: label });
  return userId;
}

const keyId = randomUUID();

type Gives = { voiceSec?: number; smsSeg?: number; callsOut?: number; chatUnits?: number };

/** An operator's grant, as POST /v1/billing/top-ups makes it. */
async function grant(tx: DatabaseTransaction, businessId: string, gives: Gives, options: { startsAt?: Date; endsAt?: Date | null; key?: string; hash?: string } = {}) {
  return await inBusiness(tx, businessId, (scoped) => grantTopUpInTransaction(scoped, {
    businessId,
    grantor: { keyId, partner: "lobbystack" },
    grant: { voiceSec: gives.voiceSec ?? 0, smsSeg: gives.smsSeg ?? 0, callsOut: gives.callsOut ?? 0, chatUnits: gives.chatUnits ?? 0, startsAt: options.startsAt ?? new Date(), endsAt: options.endsAt ?? null, note: "Spring promotion" },
    idempotencyKey: options.key ?? null,
    requestHash: options.hash ?? null,
  }));
}

async function topUpRow(tx: DatabaseTransaction, id: string) {
  const [row] = await tx.select({ voiceUsed: billingTopUps.voiceUsed, smsUsed: billingTopUps.smsUsed, callsUsed: billingTopUps.callsUsed, chatUsed: billingTopUps.chatUsed, status: billingTopUps.status }).from(billingTopUps).where(eq(billingTopUps.id, id));
  return row!;
}

async function usageRow(tx: DatabaseTransaction, businessId: string, sourceKey: string) {
  const [row] = await tx.select({ quantity: billingUsageEvents.quantity, topUpQuantity: billingUsageEvents.topUpQuantity, billableQuantity: billingUsageEvents.billableQuantity, syncStatus: billingUsageEvents.syncStatus }).from(billingUsageEvents).where(and(eq(billingUsageEvents.businessId, businessId), eq(billingUsageEvents.sourceKey, sourceKey)));
  return row!;
}

async function draws(tx: DatabaseTransaction, sourceKey: string) {
  const rows = await tx.select({ topUpId: billingTopUpDraws.topUpId, units: billingTopUpDraws.units }).from(billingTopUpDraws).where(eq(billingTopUpDraws.sourceKey, sourceKey));
  return Object.fromEntries(rows.map((row) => [row.topUpId, row.units]));
}

const status = (tx: DatabaseTransaction, businessId: string) => asWorker(tx, (context) => getBillingUsageStatus(context, { businessId }));

/** A finished call the plan already paid for, recorded as a call's finish records one that reserved nothing. */
const usedSeconds = (tx: DatabaseTransaction, businessId: string, seconds: number) =>
  inBusiness(tx, businessId, (scoped) => correctUsageInTransaction(scoped, { businessId, sourceKey: `voice:${randomUUID()}`, usageKind: "voice_seconds", quantity: seconds }));

const call = (businessId: string, from: string) => ({ businessId, sessionId: `live_${randomUUID()}`, from, to: "+15815550100" });

/** A top-up code, as POST /v1/billing/codes issues one. */
async function code(tx: DatabaseTransaction, input: { code: string; gives?: Gives; days?: number | null; maxUses?: number | null; expiresAt?: Date | null; businessId?: string | null }) {
  const gives = input.gives ?? { voiceSec: 1_200 };
  const [row] = await tx.insert(billingCodes).values({ code: input.code, plan: null, voiceSec: gives.voiceSec ?? 0, smsSeg: gives.smsSeg ?? 0, callsOut: gives.callsOut ?? 0, chatUnits: gives.chatUnits ?? 0, days: input.days === undefined ? 30 : input.days, maxUses: input.maxUses === undefined ? 10 : input.maxUses, expiresAt: input.expiresAt === undefined ? new Date(Date.now() + 7 * DAY) : input.expiresAt, businessId: input.businessId ?? null, keyId, partner: "lobbystack" }).returning({ id: billingCodes.id });
  return row!.id;
}

describe.skipIf(!testUrl)("top-ups against PostgreSQL", () => {
  it("leaves a business without a top-up as it was", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      expect(await status(tx, businessId)).toMatchObject({ plan: "free_cloud", voiceSecondsIncluded: 1_800, voiceSecondsLeft: 1_800, topUp: null });
      await usedSeconds(tx, businessId, 1_800);
      expect(await status(tx, businessId)).toMatchObject({ voiceSecondsUsed: 1_800, voiceSecondsLeft: 0, voiceBlocked: true, topUp: null });
      await expect(asWorker(tx, (context) => startLivePhoneCall(context, call(businessId, "+14165550134")))).rejects.toMatchObject({ code: "voice_limit_reached" });
      expect(await inBusiness(tx, businessId, (scoped) => listBusinessTopUps(scoped, businessId))).toEqual([]);
    });
  });

  it("gives Free calls the top-up's seconds once the month's are used up, keeps the plan, and gives back what a call didn't use", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const { topUp } = await grant(tx, businessId, { voiceSec: 600 });
      expect(topUp).toMatchObject({ source: "grant", status: "active", note: "Spring promotion", gives: { voiceSeconds: 600, alertSmsSegments: 0 }, used: { voiceSeconds: 0 }, endsAt: null });
      // The plan stays Free; its own seconds come first.
      expect(await status(tx, businessId)).toMatchObject({ plan: "free_cloud", voiceSecondsIncluded: 1_800, voiceSecondsLeft: 2_400, topUp: { voiceSeconds: { total: 600, used: 0, left: 600 }, nextEndsAt: null, lastEndsAt: null } });
      await usedSeconds(tx, businessId, 1_800);
      expect(await status(tx, businessId)).toMatchObject({ voiceSecondsUsed: 1_800, voiceSecondsLeft: 600, voiceBlocked: false });
      expect((await topUpRow(tx, topUp.id)).voiceUsed).toBe(0);

      const live = await asWorker(tx, (context) => startLivePhoneCall(context, call(businessId, "+14165550134")));
      expect(live.maxDurationMs).toBe(300_000);
      const sourceKey = `voice:${live.callId}`;
      expect(await usageRow(tx, businessId, sourceKey)).toMatchObject({ quantity: 300, topUpQuantity: 300, syncStatus: "skipped" });
      expect(await draws(tx, sourceKey)).toEqual({ [topUp.id]: 300 });
      const grants = await asWorker(tx, async (context) => [await extendLiveCallReservation(context, { businessId, callId: live.callId }), await extendLiveCallReservation(context, { businessId, callId: live.callId })]);
      expect(grants).toEqual([300, 0]);
      expect((await topUpRow(tx, topUp.id)).voiceUsed).toBe(600);
      expect(await status(tx, businessId)).toMatchObject({ voiceSecondsUsed: 1_800, voiceSecondsLeft: 0, voiceBlocked: true, topUp: { voiceSeconds: { total: 600, used: 600, left: 0 } } });

      // The call used 420 of its 600 seconds: the 180 go back to the top-up, and the month's count doesn't move.
      await asWorker(tx, (context) => finishLiveCall(context, { businessId, callId: live.callId, seconds: 420, end: "caller_hung_up" }));
      expect(await usageRow(tx, businessId, sourceKey)).toMatchObject({ quantity: 420, topUpQuantity: 420 });
      expect(await draws(tx, sourceKey)).toEqual({ [topUp.id]: 420 });
      expect(await status(tx, businessId)).toMatchObject({ plan: "free_cloud", voiceSecondsUsed: 1_800, voiceSecondsLeft: 180, voiceBlocked: false, topUp: { voiceSeconds: { total: 600, used: 420, left: 180 } } });
      const [account] = await tx.select({ plan: billingAccounts.plan, subscriptionState: billingAccounts.subscriptionState }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId));
      expect(account).toEqual({ plan: "free_cloud", subscriptionState: null });
    });
  });

  it("splits a use between what is left of the month and the top-up, and settles the split when it is corrected", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const { topUp } = await grant(tx, businessId, { smsSeg: 5, callsOut: 1 });
      // Free has 10 alert segments a month: 8 of them, then 4 more of which the top-up pays 2.
      expect(await asWorker(tx, (context) => reserveAlertSmsUsage(context, { businessId, sourceKey: "alert_sms:first", estimatedSegments: 8 }))).toMatchObject({ allowed: true });
      expect(await asWorker(tx, (context) => reserveAlertSmsUsage(context, { businessId, sourceKey: "alert_sms:second", estimatedSegments: 4 }))).toMatchObject({ allowed: true });
      expect(await usageRow(tx, businessId, "alert_sms:second")).toMatchObject({ quantity: 4, topUpQuantity: 2 });
      expect((await topUpRow(tx, topUp.id)).smsUsed).toBe(2);
      expect(await status(tx, businessId)).toMatchObject({ alertSmsSegmentsUsed: 10, alertSmsBlocked: false, topUp: { alertSmsSegments: { total: 5, used: 2, left: 3 } } });
      // The first text went out as 6 segments: the month has 2 back, so the second one's top-up share goes back.
      await asWorker(tx, (context) => correctAlertSmsUsage(context, { businessId, sourceKey: "alert_sms:first", segments: 6 }));
      await asWorker(tx, (context) => correctAlertSmsUsage(context, { businessId, sourceKey: "alert_sms:second", segments: 4 }));
      expect(await usageRow(tx, businessId, "alert_sms:second")).toMatchObject({ quantity: 4, topUpQuantity: 0 });
      expect((await topUpRow(tx, topUp.id)).smsUsed).toBe(0);
      // More than the month and the top-up hold together is refused, as on Free without one.
      expect(await asWorker(tx, (context) => reserveAlertSmsUsage(context, { businessId, sourceKey: "alert_sms:third", estimatedSegments: 6 }))).toMatchObject({ allowed: false, errorCode: "alert_sms_limit_reached" });
      expect(await asWorker(tx, (context) => reserveAlertSmsUsage(context, { businessId, sourceKey: "alert_sms:third", estimatedSegments: 5 }))).toMatchObject({ allowed: true });
      expect(await usageRow(tx, businessId, "alert_sms:third")).toMatchObject({ quantity: 5, topUpQuantity: 5 });

      // Free has 2 transfers: the third comes from the top-up, the fourth is refused.
      const transfers = await asWorker(tx, async (context) => {
        const results: boolean[] = [];
        for (let attempt = 0; attempt < 4; attempt += 1) results.push((await reserveOutboundCallAttempt(context, { businessId, sourceKey: `outbound_call:${attempt}` })).allowed);
        return results;
      });
      expect(transfers).toEqual([true, true, true, false]);
      expect(await usageRow(tx, businessId, "outbound_call:2")).toMatchObject({ quantity: 1, topUpQuantity: 1 });
      expect((await topUpRow(tx, topUp.id)).callsUsed).toBe(1);
    });
  });

  it("lets Free's website chats carry on with the top-up's chats", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const chat = (conversation: number) => inBusiness(tx, businessId, (scoped) => reserveWidgetChatUsageInTransaction(scoped, { businessId, conversationId: `${businessId.slice(0, 8)}-${conversation}`, dailyPercent: null }));
      for (let conversation = 0; conversation < 5; conversation += 1) expect(await chat(conversation)).toMatchObject({ allowed: true });
      expect(await asWorker(tx, (context) => getWidgetChatAllowance(context, { businessId }))).toMatchObject({ allowed: false });
      expect(await chat(5)).toMatchObject({ allowed: false });
      const { topUp } = await grant(tx, businessId, { chatUnits: 2 });
      expect(await asWorker(tx, (context) => getWidgetChatAllowance(context, { businessId }))).toMatchObject({ allowed: true });
      expect([await chat(6), await chat(7), await chat(8)].map((result) => result.allowed)).toEqual([true, true, false]);
      expect((await topUpRow(tx, topUp.id)).chatUsed).toBe(2);
    });
  });

  it("pays a capped Starter plan's overage with the top-up first, so the provider is sent only what the top-up didn't pay", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx, { plan: "starter", capCents: 1_000 });
      const { topUp } = await grant(tx, businessId, { voiceSec: 120, chatUnits: 10 });
      // Starter includes 9,000 seconds; 8,940 are used, so 60 are left.
      await usedSeconds(tx, businessId, 8_940);
      const sourceKey = `voice:${randomUUID()}`;
      await inBusiness(tx, businessId, (scoped) => correctUsageInTransaction(scoped, { businessId, sourceKey, usageKind: "voice_seconds", quantity: 240 }));
      // 60 from the month, 120 from the top-up, 60 billed at 20 cents a minute.
      expect(await usageRow(tx, businessId, sourceKey)).toMatchObject({ quantity: 240, topUpQuantity: 120, billableQuantity: 60, syncStatus: "pending" });
      expect(await status(tx, businessId)).toMatchObject({ plan: "starter", voiceSecondsUsed: 9_060, overageSpendCents: 20, topUp: { voiceSeconds: { used: 120, left: 0 } } });
      expect((await topUpRow(tx, topUp.id)).voiceUsed).toBe(120);
      // A paid plan's chats cost nothing past their allowance, so they never draw on the top-up.
      const chats = await inBusiness(tx, businessId, async (scoped) => {
        for (let conversation = 0; conversation < 51; conversation += 1) await reserveWidgetChatUsageInTransaction(scoped, { businessId, conversationId: `${businessId.slice(0, 8)}-${conversation}`, dailyPercent: null });
        return (await topUpRow(tx, topUp.id)).chatUsed;
      });
      expect(chats).toBe(0);
    });
  });

  it("pays an uncapped Starter call's overage with the top-up when the call's finish records it", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx, { plan: "starter" });
      await grant(tx, businessId, { voiceSec: 300 });
      await usedSeconds(tx, businessId, 9_000);
      // Without a cap a call reserves nothing; its finish records it, past the allowance, on the top-up.
      const live = await asWorker(tx, (context) => startLivePhoneCall(context, call(businessId, "+14165550134")));
      expect(live.maxDurationMs).toBeUndefined();
      await asWorker(tx, (context) => finishLiveCall(context, { businessId, callId: live.callId, seconds: 420, end: "caller_hung_up" }));
      expect(await usageRow(tx, businessId, `voice:${live.callId}`)).toMatchObject({ quantity: 420, topUpQuantity: 300, billableQuantity: 120 });
      expect(await status(tx, businessId)).toMatchObject({ voiceSecondsUsed: 9_120, overageSpendCents: 40 });
    });
  });

  it("draws on a pack first and the top-up after it on the prepaid tier", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      await tx.insert(billingPackPlans).values({ code: "pack_top_up_test", status: "active", names: { en: "Test pack", fr: "Test pack", es: "Test pack", sr: "Test pack" }, voiceSec: 400, days: 90, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, termsHash: "0".repeat(64) }).onConflictDoNothing();
      const paidAt = new Date(Date.now() - DAY);
      const [pack] = await tx.insert(billingPacks).values({ businessId, pack: "pack_top_up_test", days: 90, provider: "stripe", providerRef: `pi_${randomUUID()}`, amountCents: 10_000, currency: "cad", secondsTotal: 400, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, paidAt, endsAt: new Date(paidAt.getTime() + 90 * DAY) }).returning({ id: billingPacks.id });
      const { topUp } = await grant(tx, businessId, { voiceSec: 300 }, { endsAt: new Date(Date.now() + 30 * DAY) });
      expect(await status(tx, businessId)).toMatchObject({ plan: "prepaid", voiceSecondsLeft: 700, pack: { secondsLeft: 400 }, topUp: { voiceSeconds: { left: 300 } } });
      const [first, second] = await asWorker(tx, async (context) => [await startLivePhoneCall(context, call(businessId, "+14165550134")), await startLivePhoneCall(context, call(businessId, "+14165550135"))]);
      expect(await usageRow(tx, businessId, `voice:${first!.callId}`)).toMatchObject({ quantity: 300, topUpQuantity: 0 });
      // The pack had 100 seconds left; the top-up pays the other 200.
      expect(await usageRow(tx, businessId, `voice:${second!.callId}`)).toMatchObject({ quantity: 300, topUpQuantity: 200 });
      expect(await draws(tx, `voice:${second!.callId}`)).toEqual({ [topUp.id]: 200 });
      expect(await asWorker(tx, (context) => extendLiveCallReservation(context, { businessId, callId: first!.callId }))).toBe(100);
      await expect(asWorker(tx, (context) => startLivePhoneCall(context, call(businessId, "+14165550136")))).rejects.toMatchObject({ code: "voice_limit_reached" });
      // The second call used 150 seconds: the top-up gets its 200 back, the pack keeps its 100 and 50 more.
      await asWorker(tx, (context) => finishLiveCall(context, { businessId, callId: second!.callId, seconds: 150, end: "caller_hung_up" }));
      expect(await usageRow(tx, businessId, `voice:${second!.callId}`)).toMatchObject({ quantity: 150, topUpQuantity: 50 });
      const [packRow] = await tx.select({ secondsUsed: billingPacks.secondsUsed }).from(billingPacks).where(eq(billingPacks.id, pack!.id));
      expect(packRow!.secondsUsed).toBe(400);
      expect((await topUpRow(tx, topUp.id)).voiceUsed).toBe(150);
    });
  });

  it("counts a top-up only from its start to its end, and stops what a revoked one holds", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      await usedSeconds(tx, businessId, 1_800);
      const later = await grant(tx, businessId, { voiceSec: 600 }, { startsAt: new Date(Date.now() + 2 * DAY), endsAt: new Date(Date.now() + 9 * DAY) });
      const ended = await grant(tx, businessId, { voiceSec: 600 }, { startsAt: new Date(Date.now() - 9 * DAY), endsAt: new Date(Date.now() - DAY) });
      expect(await status(tx, businessId)).toMatchObject({ voiceSecondsLeft: 0, voiceBlocked: true, topUp: null });
      const live = await grant(tx, businessId, { voiceSec: 600 }, { endsAt: new Date(Date.now() + 3 * DAY) });
      expect(await status(tx, businessId)).toMatchObject({ voiceSecondsLeft: 600, voiceBlocked: false, topUp: { nextEndsAt: new Date(live.topUp.endsAt!) } });
      const started = await asWorker(tx, (context) => startLivePhoneCall(context, call(businessId, "+14165550134")));
      expect(started.maxDurationMs).toBe(300_000);
      const revoked = await inBusiness(tx, businessId, (scoped) => revokeTopUpInTransaction(scoped, { businessId, topUpId: live.topUp.id }));
      expect(revoked).toMatchObject({ status: "revoked", used: { voiceSeconds: 300 } });
      // Revoking again returns it as it is; uses it paid for stay paid, and it holds nothing more.
      expect(await inBusiness(tx, businessId, (scoped) => revokeTopUpInTransaction(scoped, { businessId, topUpId: live.topUp.id }))).toMatchObject({ status: "revoked" });
      expect(await asWorker(tx, (context) => extendLiveCallReservation(context, { businessId, callId: started.callId }))).toBe(0);
      expect(await status(tx, businessId)).toMatchObject({ voiceSecondsLeft: 0, voiceBlocked: true, topUp: null });
      // Every grant here shares one transaction's now(); the ended one was added a day earlier.
      await tx.update(billingTopUps).set({ createdAt: new Date(Date.now() - DAY) }).where(eq(billingTopUps.id, ended.topUp.id));
      const listed = await inBusiness(tx, businessId, (scoped) => listBusinessTopUps(scoped, businessId));
      expect(listed.map((topUp) => [topUp.id, topUp.status])).toEqual([[later.topUp.id, "scheduled"], [live.topUp.id, "revoked"], [ended.topUp.id, "expired"]]);
      expect(await inBusiness(tx, businessId, (scoped) => revokeTopUpInTransaction(scoped, { businessId, topUpId: randomUUID() }))).toBeNull();
    });
  });

  it("returns a grant its Idempotency-Key made, and refuses the key with another request", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const other = await business(tx);
      const first = await grant(tx, businessId, { voiceSec: 600 }, { key: "grant-1", hash: "a".repeat(64) });
      const again = await grant(tx, businessId, { voiceSec: 600 }, { key: "grant-1", hash: "a".repeat(64) });
      expect(again).toEqual({ topUp: first.topUp, replayed: true });
      await expect(grant(tx, businessId, { voiceSec: 900 }, { key: "grant-1", hash: "b".repeat(64) })).rejects.toBeInstanceOf(TopUpIdempotencyConflict);
      // The same key for another business, which this one can't see, is refused too.
      await expect(tx.transaction(() => grant(tx, other, { voiceSec: 600 }, { key: "grant-1", hash: "a".repeat(64) }))).rejects.toBeInstanceOf(TopUpIdempotencyConflict);
      const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(billingTopUps).where(eq(billingTopUps.businessId, businessId));
      expect(count!.n).toBe(1);
    });
  });

  it("keeps the dashboard from writing a top-up but through a code, and every business to its own", async () => {
    await rollbackTest(async (tx) => {
      const owner = await ownedBusiness(tx, "rls");
      const other = await business(tx);
      await grant(tx, other, { voiceSec: 600 });
      const insert = () => asPerson(tx, owner, (scoped) => scoped.execute(sql`insert into public.billing_top_ups (business_id, source, key_id, partner, voice_sec) values (${owner.businessId}::uuid, 'grant', ${keyId}::uuid, 'lobbystack', 600)`));
      await expect(tx.transaction(insert)).rejects.toThrow();
      // Another business's top-ups are out of sight.
      expect(await asPerson(tx, owner, (scoped) => listBusinessTopUps(scoped, other))).toEqual([]);
    });
  });

  it("adds a top-up code's top-up at once, once per business and once per person, for the code's days", async () => {
    await rollbackTest(async (tx) => {
      const first = await ownedBusiness(tx, "first");
      const second = await ownedBusiness(tx, "second");
      await code(tx, { code: "SPRING-MINUTES", gives: { voiceSec: 1_200, smsSeg: 20 }, days: 30, maxUses: 10 });
      const view = await asPerson(tx, first, (scoped) => topUpCodeView(scoped, " spring-minutes "));
      expect(view).toEqual({ kind: "top_up", code: "SPRING-MINUTES", gives: { voiceSeconds: 1_200, alertSmsSegments: 20, outboundCallAttempts: 0, chatAiUnits: 0 }, days: 30, usedHere: false, usedByYou: false });
      // A top-up code is never a plan's offer.
      expect(await asPerson(tx, first, (scoped) => findBillingCodeOffer(scoped, "SPRING-MINUTES"))).toBeNull();

      const added = await asPerson(tx, first, (scoped) => redeemTopUpCodeInTransaction(scoped, { businessId: first.businessId, code: "spring-minutes" }));
      expect(added).toMatchObject({ topUp: { source: "code", code: "SPRING-MINUTES", status: "active", gives: { voiceSeconds: 1_200, alertSmsSegments: 20 } } });
      const topUp = "topUp" in added ? added.topUp : null;
      expect(Date.parse(topUp!.endsAt!) - Date.parse(topUp!.startsAt)).toBe(30 * DAY);
      expect(await status(tx, first.businessId)).toMatchObject({ plan: "free_cloud", voiceSecondsLeft: 3_000, topUp: { voiceSeconds: { total: 1_200 } } });
      // Once per business, whoever on its team types it, and once per person, whatever business they type it for.
      const teammate = await person(tx, "teammate");
      await tx.execute(sql`insert into public.business_memberships (business_id, user_id, role, status) values (${first.businessId}::uuid, ${teammate}::uuid, 'business_admin', 'active')`);
      expect(await asPerson(tx, { userId: teammate, businessId: first.businessId }, (scoped) => redeemTopUpCodeInTransaction(scoped, { businessId: first.businessId, code: "SPRING-MINUTES" }))).toEqual({ refusal: "used" });
      expect(await asPerson(tx, { userId: teammate, businessId: first.businessId }, (scoped) => topUpCodeView(scoped, "SPRING-MINUTES"))).toMatchObject({ usedHere: true, usedByYou: false });
      await tx.execute(sql`insert into public.business_memberships (business_id, user_id, role, status) values (${second.businessId}::uuid, ${first.userId}::uuid, 'business_admin', 'active')`);
      expect(await asPerson(tx, { userId: first.userId, businessId: second.businessId }, (scoped) => redeemTopUpCodeInTransaction(scoped, { businessId: second.businessId, code: "SPRING-MINUTES" }))).toEqual({ refusal: "used" });
      expect(await asPerson(tx, second, (scoped) => redeemTopUpCodeInTransaction(scoped, { businessId: second.businessId, code: "SPRING-MINUTES" }))).toMatchObject({ topUp: { code: "SPRING-MINUTES" } });
      const [row] = await tx.select({ uses: billingCodes.uses }).from(billingCodes).where(eq(billingCodes.code, "SPRING-MINUTES"));
      expect(row!.uses).toBe(2);
    });
  });

  it("refuses a top-up code that is used up, expired, revoked, bound to another business or a plan's, all alike", async () => {
    await rollbackTest(async (tx) => {
      const owner = await ownedBusiness(tx, "refusals");
      const other = await ownedBusiness(tx, "other");
      await code(tx, { code: "LAST-MINUTES", maxUses: 1 });
      await code(tx, { code: "OLD-MINUTES", expiresAt: new Date(Date.now() - DAY) });
      await code(tx, { code: "GONE-MINUTES" });
      await tx.update(billingCodes).set({ status: "revoked", revokedAt: new Date() }).where(eq(billingCodes.code, "GONE-MINUTES"));
      await code(tx, { code: "THEIR-MINUTES", businessId: other.businessId });
      await code(tx, { code: "FOREVER-MINUTES", days: null, maxUses: null, expiresAt: null, businessId: owner.businessId });
      expect(await asPerson(tx, other, (scoped) => redeemTopUpCodeInTransaction(scoped, { businessId: other.businessId, code: "LAST-MINUTES" }))).toMatchObject({ topUp: {} });
      for (const typed of ["LAST-MINUTES", "OLD-MINUTES", "GONE-MINUTES", "THEIR-MINUTES", "NO-SUCH-CODE", "x"]) {
        expect(await asPerson(tx, owner, (scoped) => topUpCodeView(scoped, typed))).toBeNull();
        expect(await asPerson(tx, owner, (scoped) => redeemTopUpCodeInTransaction(scoped, { businessId: owner.businessId, code: typed }))).toEqual({ refusal: "invalid" });
      }
      // A code bound to the business, with no use limit or end, lasts for good once added.
      expect(await asPerson(tx, owner, (scoped) => redeemTopUpCodeInTransaction(scoped, { businessId: owner.businessId, code: "FOREVER-MINUTES" }))).toMatchObject({ topUp: { endsAt: null } });
      // Nothing was added for the codes that didn't work.
      expect((await asPerson(tx, owner, (scoped) => listBusinessTopUps(scoped, owner.businessId))).map((topUp) => topUp.code)).toEqual(["FOREVER-MINUTES"]);
      // The month's usage period keys the rows, as before.
      expect(periodKeyFor(new Date("2026-11-26T12:00:00Z"))).toBe("2026-11");
    });
  });
});
