import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { auditLogs, billingAccounts, billingPackDraws, billingPackPlans, billingPacks, billingUsageEvents, businessMemberships, businesses, createDatabaseClient, outboxMessages, phoneNumbers, users, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { expireBusinessPacks } from "./billingPackExpiry";

// The daily end of prepaid packs against PostgreSQL: packs whose end has
// come, the one settlement of each ended pack (the receptionist check and the
// number's release once the last one ended), the owners' reminders and the
// backstop for a subscription a pack replaced. A business without a pack
// must see nothing at all.

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Pack expiry integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

const DAY = 86_400_000;
const HOUR = 3_600_000;
const appUrl = "https://app.example.test/";
const names = { en: "500 minutes, 180 days", fr: "500 minutes, 180 jours", es: "500 minutos, 180 días", sr: "500 minuta, 180 dana" };

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

/** Runs the job's domain call under the worker's own login, which the owners' email lookup trusts. */
async function asWorkerLogin<T>(tx: DatabaseTransaction, run: (context: { db: Database }) => Promise<T>): Promise<T> {
  await tx.execute(sql`set local session authorization lobbystack_worker`);
  try {
    return await run({ db: tx as unknown as Database });
  } finally {
    await tx.execute(sql`reset session authorization`);
  }
}

const expire = (tx: DatabaseTransaction, businessId: string, now: Date) => asWorkerLogin(tx, (context) => expireBusinessPacks(context, { businessId, appUrl, now }));

type AccountInput = { plan?: "free_cloud" | "starter"; subscriptionState?: string; replaced?: boolean; allowancesSince?: Date };

/** A business on Free unless it says otherwise, with one number of its own. */
async function business(tx: DatabaseTransaction, input: AccountInput & { status?: "active" | "canceled" } = {}) {
  const businessId = randomUUID();
  const subscriptionId = input.plan === "starter" ? `sub_${businessId}` : null;
  await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "Pack expiry test", timezone: "America/Toronto", businessType: "test", telemetryEnabled: false, status: input.status ?? "active", canceledAt: input.status === "canceled" ? new Date() : null });
  await tx.insert(billingAccounts).values({ businessId, billingKey: `test:${businessId}`, plan: input.plan ?? "free_cloud", subscriptionState: input.plan === "starter" ? input.subscriptionState ?? "active" : null, billingInterval: input.plan === "starter" ? "month" : null, subscriptionId, replacedSubscriptionId: input.replaced ? subscriptionId : null, allowancesSince: input.allowancesSince ?? null });
  const e164 = `+1604${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`;
  await tx.insert(phoneNumbers).values({ businessId, e164 });
  return { businessId, subscriptionId, e164 };
}

async function owner(tx: DatabaseTransaction, businessId: string, locale = "en") {
  const userId = randomUUID();
  const email = `pack-owner-${userId}@example.invalid`;
  await tx.insert(users).values({ id: userId, email, normalizedEmail: email, preferredLocale: locale });
  await tx.insert(businessMemberships).values({ businessId, userId, role: "business_owner", status: "active" });
  return { userId, email };
}

async function packPlan(tx: DatabaseTransaction) {
  await tx.insert(billingPackPlans).values({ code: "pack_expiry_test", status: "active", names, voiceSec: 30_000, days: 180, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, termsHash: "0".repeat(64) }).onConflictDoNothing();
}

type PackInput = { paidAt: Date; days?: number | null; secondsUsed?: number; status?: "active" | "frozen" | "expired" | "refunded" | "replaced"; endedAt?: Date; notices?: string[] };

/** A pack of 500 minutes bought at paidAt that lasts `days`, 180 unless it says otherwise; null never ends. */
async function pack(tx: DatabaseTransaction, businessId: string, input: PackInput) {
  await packPlan(tx);
  const days = input.days === undefined ? 180 : input.days;
  const ended = input.status === "expired" || input.status === "refunded" || input.status === "replaced";
  const [row] = await tx.insert(billingPacks).values({
    businessId, pack: "pack_expiry_test", days, provider: "stripe", providerRef: `pi_${randomUUID()}`, amountCents: 9_900, currency: "cad",
    secondsTotal: 30_000, secondsUsed: input.secondsUsed ?? 0, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1,
    paidAt: input.paidAt, endsAt: days === null ? null : new Date(input.paidAt.getTime() + days * DAY), status: input.status ?? "active",
    refundedCents: input.status === "refunded" ? 9_900 : 0, endedAt: ended ? input.endedAt ?? new Date(input.paidAt.getTime() + DAY) : null, unusedSeconds: ended ? 30_000 - (input.secondsUsed ?? 0) : null, notices: input.notices ?? [],
  }).returning({ id: billingPacks.id, endsAt: billingPacks.endsAt });
  return row!;
}

/** A call on the pack that began at `at` and holds `seconds` it drew up front: its usage row, not final until the call settles, and its draw, which the pack's seconds_used already counts. */
async function reservation(tx: DatabaseTransaction, businessId: string, packId: string, input: { seconds: number; at: Date }) {
  const sourceKey = `voice:${randomUUID()}`;
  await tx.insert(billingUsageEvents).values({ businessId, periodKey: input.at.toISOString().slice(0, 7), sourceKey, usageKind: "voice_seconds", quantity: input.seconds, billableQuantity: input.seconds, planAtRecordTime: "prepaid", isFinal: false, syncStatus: "skipped", createdAt: input.at });
  await tx.insert(billingPackDraws).values({ packId, businessId, sourceKey, seconds: input.seconds });
  return sourceKey;
}

async function packRow(tx: DatabaseTransaction, id: string) {
  const [row] = await tx.select({ status: billingPacks.status, endedAt: billingPacks.endedAt, unusedSeconds: billingPacks.unusedSeconds, notices: billingPacks.notices }).from(billingPacks).where(eq(billingPacks.id, id));
  return row!;
}

async function numberRow(tx: DatabaseTransaction, businessId: string) {
  const [row] = await tx.select({ at: phoneNumbers.reclaimScheduledAt, reason: phoneNumbers.reclaimReason }).from(phoneNumbers).where(eq(phoneNumbers.businessId, businessId));
  return row!;
}

async function outbox(tx: DatabaseTransaction, businessId: string, topic?: string) {
  const rows = await tx.select({ topic: outboxMessages.topic, dedupeKey: outboxMessages.dedupeKey, aggregateType: outboxMessages.aggregateType, aggregateId: outboxMessages.aggregateId, payload: outboxMessages.payload }).from(outboxMessages)
    .where(topic ? and(eq(outboxMessages.businessId, businessId), eq(outboxMessages.topic, topic)) : eq(outboxMessages.businessId, businessId));
  return rows.sort((left, right) => left.dedupeKey.localeCompare(right.dedupeKey));
}

async function audits(tx: DatabaseTransaction, businessId: string) {
  const rows = await tx.select({ eventType: auditLogs.eventType, entityType: auditLogs.entityType, entityId: auditLogs.entityId, payload: auditLogs.payload }).from(auditLogs).where(eq(auditLogs.businessId, businessId));
  return rows.sort((left, right) => left.eventType.localeCompare(right.eventType));
}

/** The advisory locks this session holds, which a pack run takes for a business with packs. */
async function advisoryLocks(tx: DatabaseTransaction): Promise<number> {
  return Number((await tx.execute<{ n: string }>(sql`select count(*) as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`)).rows[0]!.n);
}

describe.skipIf(!testUrl)("the daily end of prepaid packs against PostgreSQL", () => {
  it("ends a pack whose end has come, keeping the minutes it still held, with an audit row and a dashboard refresh", async () => {
    await rollbackTest(async (tx) => {
      const now = new Date();
      const { businessId } = await business(tx);
      const ended = await pack(tx, businessId, { paidAt: new Date(now.getTime() - 180 * DAY - HOUR), secondsUsed: 12_000 });
      const live = await pack(tx, businessId, { paidAt: new Date(now.getTime() - 10 * DAY) });

      expect(await expire(tx, businessId, now)).toEqual({ expired: 1, settled: 1, emails: 0, releaseAt: null });
      expect(await packRow(tx, ended.id)).toEqual({ status: "expired", endedAt: ended.endsAt, unusedSeconds: 18_000, notices: ["ended"] });
      expect(await packRow(tx, live.id)).toMatchObject({ status: "active", endedAt: null, notices: [] });
      expect(await audits(tx, businessId)).toEqual([{ eventType: "billing.pack_expired", entityType: "billing_pack", entityId: ended.id, payload: { pack: "pack_expiry_test", unusedSeconds: 18_000 } }]);
      expect(await outbox(tx, businessId, "realtime.publish")).toEqual([{ topic: "realtime.publish", dedupeKey: `billing:${businessId}:packs-expired:${now.getTime()}`, aggregateType: "billing_account", aggregateId: businessId, payload: { type: "billing.updated", entityId: businessId } }]);
      // Another pack still has time left, so nothing else changes: no release, and its receptionists stay.
      expect(await numberRow(tx, businessId)).toEqual({ at: null, reason: null });
      expect(await outbox(tx, businessId, "receptionists.enforceAllowance")).toEqual([]);
    });
  });

  it("sets the number to go back 30 days after the last pack ended, checks the receptionists once, and does nothing on the next run", async () => {
    await rollbackTest(async (tx) => {
      const now = new Date();
      const { businessId } = await business(tx);
      const last = await pack(tx, businessId, { paidAt: new Date(now.getTime() - 180 * DAY - 2 * HOUR) });
      const releaseAt = new Date(last.endsAt!.getTime() + 30 * DAY);

      expect(await expire(tx, businessId, now)).toEqual({ expired: 1, settled: 1, emails: 0, releaseAt });
      expect(await packRow(tx, last.id)).toMatchObject({ status: "expired", notices: ["ended"] });
      expect(await numberRow(tx, businessId)).toEqual({ at: releaseAt, reason: "pack_ended" });
      expect((await outbox(tx, businessId, "receptionists.enforceAllowance")).map((row) => row.payload)).toEqual([{ businessId, reason: "pack_ended" }]);
      expect((await audits(tx, businessId)).map((row) => [row.eventType, row.payload])).toEqual([
        ["billing.pack_expired", { pack: "pack_expiry_test", unusedSeconds: 30_000 }],
        ["billing.pack_number_release_set", { releaseAt: releaseAt.toISOString(), reason: "pack_ended" }],
      ]);

      const queued = (await outbox(tx, businessId)).length;
      expect(await expire(tx, businessId, new Date(now.getTime() + DAY))).toEqual({ expired: 0, settled: 0, emails: 0, releaseAt: null });
      expect(await outbox(tx, businessId)).toHaveLength(queued);
      expect(await audits(tx, businessId)).toHaveLength(2);
    });
  });

  it("settles a pack a full refund ended as one that ran out its days, from the refund's date", async () => {
    await rollbackTest(async (tx) => {
      const now = new Date();
      const { businessId } = await business(tx);
      // The ledger ends a pack refunded in full when the provider's event arrives.
      const refundedAt = new Date(now.getTime() - 2 * DAY);
      const refunded = await pack(tx, businessId, { paidAt: new Date(now.getTime() - 20 * DAY), status: "refunded", endedAt: refundedAt });

      expect(await expire(tx, businessId, now)).toEqual({ expired: 0, settled: 1, emails: 0, releaseAt: new Date(refundedAt.getTime() + 30 * DAY) });
      expect(await packRow(tx, refunded.id)).toMatchObject({ status: "refunded", notices: ["ended"] });
      expect(await numberRow(tx, businessId)).toEqual({ at: new Date(refundedAt.getTime() + 30 * DAY), reason: "pack_ended" });
      expect(await outbox(tx, businessId, "receptionists.enforceAllowance")).toHaveLength(1);
      // A pack that ended more than 30 days before anyone settled it goes back now.
      const late = await business(tx);
      await pack(tx, late.businessId, { paidAt: new Date(now.getTime() - 90 * DAY), status: "refunded", endedAt: new Date(now.getTime() - 40 * DAY) });
      expect(await expire(tx, late.businessId, now)).toMatchObject({ settled: 1, releaseAt: now });
    });
  });

  it("keeps the number while a frozen pack still has time left, since a won dispute brings it back", async () => {
    await rollbackTest(async (tx) => {
      const now = new Date();
      const { businessId } = await business(tx);
      const ended = await pack(tx, businessId, { paidAt: new Date(now.getTime() - 180 * DAY - HOUR) });
      const disputed = await pack(tx, businessId, { paidAt: new Date(now.getTime() - 30 * DAY), status: "frozen" });

      expect(await expire(tx, businessId, now)).toEqual({ expired: 1, settled: 1, emails: 0, releaseAt: null });
      expect(await packRow(tx, ended.id)).toMatchObject({ status: "expired", notices: ["ended"] });
      expect(await packRow(tx, disputed.id)).toMatchObject({ status: "frozen", notices: [] });
      expect(await numberRow(tx, businessId)).toEqual({ at: null, reason: null });
      expect(await outbox(tx, businessId, "receptionists.enforceAllowance")).toEqual([]);

      // A frozen pack whose end came ends like any other, and then the last pack has ended.
      const later = new Date(disputed.endsAt!.getTime() + HOUR);
      const result = await expire(tx, businessId, later);
      expect(result).toEqual({ expired: 1, settled: 1, emails: 0, releaseAt: new Date(Math.max(disputed.endsAt!.getTime() + 30 * DAY, later.getTime())) });
      expect(await packRow(tx, disputed.id)).toMatchObject({ status: "expired", endedAt: disputed.endsAt, notices: ["ended"] });
    });
  });

  it("never settles a pack a subscription replaced, nor releases the number for it", async () => {
    await rollbackTest(async (tx) => {
      const now = new Date();
      const { businessId } = await business(tx, { plan: "starter" });
      const replaced = await pack(tx, businessId, { paidAt: new Date(now.getTime() - 20 * DAY), status: "replaced", endedAt: new Date(now.getTime() - 5 * DAY) });

      expect(await expire(tx, businessId, now)).toEqual({ expired: 0, settled: 0, emails: 0, releaseAt: null });
      expect(await packRow(tx, replaced.id)).toMatchObject({ status: "replaced", notices: [] });
      expect(await numberRow(tx, businessId)).toEqual({ at: null, reason: null });
      expect(await outbox(tx, businessId)).toEqual([]);
    });
  });

  it("keeps the number of a business whose plan includes one when its last pack ends, as on Starter", async () => {
    await rollbackTest(async (tx) => {
      const now = new Date();
      // The subscription went live after the pack's end and before the job ran, so reconcile left the pack to it.
      const { businessId } = await business(tx, { plan: "starter" });
      const last = await pack(tx, businessId, { paidAt: new Date(now.getTime() - 180 * DAY - HOUR) });

      expect(await expire(tx, businessId, now)).toEqual({ expired: 1, settled: 1, emails: 0, releaseAt: null });
      expect(await packRow(tx, last.id)).toMatchObject({ status: "expired", notices: ["ended"] });
      expect(await numberRow(tx, businessId)).toEqual({ at: null, reason: null });
      expect((await audits(tx, businessId)).map((row) => row.eventType)).toEqual(["billing.pack_expired"]);
    });
  });

  it("returns at once for a business without a pack, taking no lock and writing nothing", async () => {
    await rollbackTest(async (tx) => {
      const now = new Date();
      const { businessId } = await business(tx);
      await owner(tx, businessId);
      const before = await advisoryLocks(tx);

      expect(await expire(tx, businessId, now)).toEqual({ expired: 0, settled: 0, emails: 0, releaseAt: null });
      expect(await advisoryLocks(tx)).toBe(before);
      expect(await outbox(tx, businessId)).toEqual([]);
      expect(await audits(tx, businessId)).toEqual([]);
      expect(await numberRow(tx, businessId)).toEqual({ at: null, reason: null });

      // One with a pack takes the number claim, billing account and pack locks.
      const withPack = await business(tx);
      await pack(tx, withPack.businessId, { paidAt: new Date(now.getTime() - 10 * DAY) });
      await expire(tx, withPack.businessId, now);
      expect(await advisoryLocks(tx)).toBe(before + 3);
    });
  });

  it("emails each owner the reminders due once, in their language, recording them on the pack", async () => {
    await rollbackTest(async (tx) => {
      const now = new Date();
      const { businessId } = await business(tx);
      const english = await owner(tx, businessId);
      const french = await owner(tx, businessId, "fr");
      // Five days left of 180, after a missed run: only the week's reminder goes.
      const ending = await pack(tx, businessId, { paidAt: new Date(now.getTime() - 175 * DAY) });

      expect(await expire(tx, businessId, now)).toEqual({ expired: 0, settled: 0, emails: 2, releaseAt: null });
      const emails = await outbox(tx, businessId, "email.send");
      expect(emails.map((row) => [row.dedupeKey, row.aggregateType, row.aggregateId])).toEqual([
        [`billing-pack:${ending.id}:ends_7:${english.userId}`, "billing_pack", ending.id],
        [`billing-pack:${ending.id}:ends_7:${french.userId}`, "billing_pack", ending.id],
      ].sort((left, right) => left[0]!.localeCompare(right[0]!)));
      const variables = { businessName: "Pack expiry test", reminder: "ends_7", minutesLeft: "500", date: ending.endsAt!.toISOString(), timeZone: "America/Toronto", url: "https://app.example.test/settings/plan" };
      expect(emails.find((row) => row.dedupeKey.endsWith(english.userId))?.payload).toEqual({ template: "pack_reminder", to: english.email, variables: { locale: "en", packName: names.en, ...variables } });
      expect(emails.find((row) => row.dedupeKey.endsWith(french.userId))?.payload).toEqual({ template: "pack_reminder", to: french.email, variables: { locale: "fr", packName: names.fr, ...variables } });
      expect((await packRow(tx, ending.id)).notices).toEqual(["ends_30", "ends_7"]);
      // Reminders change nothing the dashboard shows.
      expect(await outbox(tx, businessId, "realtime.publish")).toEqual([]);

      // The next run has nothing to send until the balance runs low.
      expect(await expire(tx, businessId, new Date(now.getTime() + HOUR))).toMatchObject({ emails: 0 });
      await tx.update(billingPacks).set({ secondsUsed: 25_000 }).where(eq(billingPacks.id, ending.id));
      expect(await expire(tx, businessId, new Date(now.getTime() + 2 * HOUR))).toMatchObject({ emails: 2 });
      const low = (await outbox(tx, businessId, "email.send")).filter((row) => row.dedupeKey.includes(":low:"));
      expect(low.map((row) => row.dedupeKey).sort()).toEqual([`billing-pack:${ending.id}:low:${english.userId}`, `billing-pack:${ending.id}:low:${french.userId}`].sort());
      // 5,000 seconds are about 83 minutes, on all the business's live packs.
      expect(low[0]?.payload).toMatchObject({ variables: { reminder: "low", minutesLeft: "83" } });
      expect((await packRow(tx, ending.id)).notices).toEqual(["ends_30", "ends_7", "low"]);
    });
  });

  it("reads the balance reminders without what a call still running holds, so its last minutes reserved aren't none left until it settles", async () => {
    await rollbackTest(async (tx) => {
      const now = new Date();
      const { businessId } = await business(tx);
      const { userId } = await owner(tx, businessId);
      // A call that began five minutes ago took the pack's last 300 seconds up front.
      const last = await pack(tx, businessId, { paidAt: new Date(now.getTime() - 10 * DAY), secondsUsed: 30_000 });
      const sourceKey = await reservation(tx, businessId, last.id, { seconds: 300, at: new Date(now.getTime() - 5 * 60_000) });

      // Before the call, 300 of 30,000 seconds were left: low, not empty.
      const low = { dedupeKey: `billing-pack:${last.id}:low:${userId}`, payload: { variables: { reminder: "low", minutesLeft: "5" } } };
      expect(await expire(tx, businessId, now)).toMatchObject({ emails: 1 });
      expect(await outbox(tx, businessId, "email.send")).toMatchObject([low]);
      expect((await packRow(tx, last.id)).notices).toEqual(["low"]);
      // Still running ten minutes on, it still holds them.
      const later = new Date(now.getTime() + 10 * 60_000);
      expect(await expire(tx, businessId, later)).toMatchObject({ emails: 0 });

      // It settles having used all 300: none is left, and the owners hear it.
      await tx.update(billingUsageEvents).set({ isFinal: true }).where(and(eq(billingUsageEvents.businessId, businessId), eq(billingUsageEvents.sourceKey, sourceKey)));
      expect(await expire(tx, businessId, later)).toMatchObject({ emails: 1 });
      expect(await outbox(tx, businessId, "email.send")).toMatchObject([{ dedupeKey: `billing-pack:${last.id}:empty:${userId}`, payload: { variables: { reminder: "empty", minutesLeft: "0" } } }, low]);
      expect((await packRow(tx, last.id)).notices).toEqual(["low", "empty"]);
    });
  });

  it("counts what a call's reservation drew as used once it is older than the longest call and a margin, so a stuck one can't hide an empty balance", async () => {
    await rollbackTest(async (tx) => {
      const now = new Date();
      const { businessId } = await business(tx);
      const { userId } = await owner(tx, businessId);
      const last = await pack(tx, businessId, { paidAt: new Date(now.getTime() - 10 * DAY), secondsUsed: 30_000, notices: ["low"] });
      // Never settled, 40 minutes after it began: no call runs that long.
      await reservation(tx, businessId, last.id, { seconds: 300, at: new Date(now.getTime() - 40 * 60_000) });

      expect(await expire(tx, businessId, now)).toMatchObject({ emails: 1 });
      expect((await outbox(tx, businessId, "email.send")).map((row) => row.dedupeKey)).toEqual([`billing-pack:${last.id}:empty:${userId}`]);
      expect((await packRow(tx, last.id)).notices).toEqual(["low", "empty"]);
    });
  });

  it("records a reminder no owner can get, and sends a canceled business none", async () => {
    await rollbackTest(async (tx) => {
      const now = new Date();
      const nobody = await business(tx);
      const empty = await pack(tx, nobody.businessId, { paidAt: new Date(now.getTime() - 5 * DAY), secondsUsed: 30_000 });
      expect(await expire(tx, nobody.businessId, now)).toEqual({ expired: 0, settled: 0, emails: 0, releaseAt: null });
      expect((await packRow(tx, empty.id)).notices).toEqual(["low", "empty"]);

      const closed = await business(tx, { status: "canceled" });
      await owner(tx, closed.businessId);
      const unheard = await pack(tx, closed.businessId, { paidAt: new Date(now.getTime() - 5 * DAY), secondsUsed: 30_000 });
      expect(await expire(tx, closed.businessId, now)).toEqual({ expired: 0, settled: 0, emails: 0, releaseAt: null });
      expect((await packRow(tx, unheard.id)).notices).toEqual([]);
      expect(await outbox(tx, closed.businessId, "email.send")).toEqual([]);
    });
  });

  it("asks again, once a day, to end a subscription a pack replaced while it is still live", async () => {
    await rollbackTest(async (tx) => {
      const now = new Date();
      const since = new Date(now.getTime() - 3 * DAY);
      const replaced = await business(tx, { plan: "starter", replaced: true, allowancesSince: since });
      await pack(tx, replaced.businessId, { paidAt: since });

      await expire(tx, replaced.businessId, now);
      expect(await outbox(tx, replaced.businessId, "billing.endPlanForPack")).toEqual([{ topic: "billing.endPlanForPack", dedupeKey: `end-plan-for-pack:${replaced.subscriptionId}:${now.toISOString().slice(0, 10)}`, aggregateType: "billing_account", aggregateId: replaced.businessId, payload: { subscriptionId: replaced.subscriptionId, since: since.toISOString() } }]);
      // Again the same day queues nothing new; the next day does.
      await expire(tx, replaced.businessId, new Date(now.getTime() + 60_000));
      expect(await outbox(tx, replaced.businessId, "billing.endPlanForPack")).toHaveLength(1);
      const tomorrow = new Date(now.getTime() + DAY);
      await expire(tx, replaced.businessId, tomorrow);
      expect((await outbox(tx, replaced.businessId, "billing.endPlanForPack")).map((row) => row.dedupeKey)).toContain(`end-plan-for-pack:${replaced.subscriptionId}:${tomorrow.toISOString().slice(0, 10)}`);

      // An ended subscription, and one no pack replaced, need nothing.
      const ended = await business(tx, { plan: "starter", replaced: true, subscriptionState: "canceled" });
      await pack(tx, ended.businessId, { paidAt: since });
      const kept = await business(tx, { plan: "starter" });
      await pack(tx, kept.businessId, { paidAt: since, status: "replaced", endedAt: now });
      for (const { businessId } of [ended, kept]) {
        await expire(tx, businessId, now);
        expect(await outbox(tx, businessId, "billing.endPlanForPack")).toEqual([]);
      }
    });
  });
});
