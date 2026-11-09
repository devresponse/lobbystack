import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { billingAccounts, billingUsageEvents, businesses, createDatabaseClient, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { loadPlanEndForPackWork } from "./billingPlanEndForPack";

// What billing.endPlanForPack reads before it ends a subscription a prepaid
// pack replaced, against PostgreSQL and as the worker: which subscription to
// end, the usage to send first, and the calls to wait for.

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

const HOUR = 3_600_000;
const switchedAt = new Date("2026-11-09T12:00:00.000Z");
const periodEnd = new Date("2026-11-20T00:00:00.000Z");

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

/** Runs the read as the worker runtime role, the way billing.endPlanForPack does. */
async function asWorker<T>(tx: DatabaseTransaction, run: (context: { db: Database }) => Promise<T>): Promise<T> {
  await tx.execute(sql`set local role lobbystack_worker`);
  const result = await run({ db: tx as unknown as Database });
  await tx.execute(sql`reset role`);
  return result;
}

/** A business on monthly Starter through Stripe whose subscription a pack replaced, unless the account says otherwise. */
async function business(tx: DatabaseTransaction, account: Partial<typeof billingAccounts.$inferInsert> = {}) {
  const businessId = randomUUID();
  await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "Plan end for pack test", timezone: "UTC", businessType: "test", telemetryEnabled: false });
  await tx.insert(billingAccounts).values({ businessId, billingKey: `test:${businessId}`, source: "stripe", customerId: `cus_${businessId}`, plan: "starter", billingInterval: "monthly", subscriptionState: "active", subscriptionId: "sub_plan", overageSubscriptionId: `sub_overage_${businessId}`, currentPeriodEnd: periodEnd, replacedSubscriptionId: "sub_plan", allowancesSince: switchedAt, ...account });
  return businessId;
}

/** A usage row: final and pending on Starter unless it says otherwise, recorded `minutes` from the switch. */
async function usage(tx: DatabaseTransaction, businessId: string, input: { minutes: number; usageKind?: string; plan?: string | null; isFinal?: boolean; syncStatus?: string }) {
  const [row] = await tx.insert(billingUsageEvents).values({
    businessId,
    periodKey: "2026-11",
    sourceKey: `test:${randomUUID()}`,
    usageKind: input.usageKind ?? "voice_seconds",
    quantity: 60,
    planAtRecordTime: input.plan === undefined ? "starter" : input.plan,
    isFinal: input.isFinal ?? true,
    syncStatus: input.syncStatus ?? "pending",
    createdAt: new Date(switchedAt.getTime() + input.minutes * 60_000),
  }).returning({ id: billingUsageEvents.id });
  return row!.id;
}

describe.skipIf(!testUrl)("the work of ending a subscription a prepaid pack replaced, against PostgreSQL", () => {
  it("reads a replaced subscription that is still the account's own with its overage subscription, interval, state, period's end and the switch's time", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const work = await asWorker(tx, (context) => loadPlanEndForPackWork(context, { businessId, subscriptionId: "sub_plan" }));
      expect(work).toEqual({ current: true, overageSubscriptionId: `sub_overage_${businessId}`, billingInterval: "monthly", subscriptionState: "active", periodEnd, switchedAt, pendingUsage: [], unsettled: 0 });
    });
  });

  it("still reads one the business replaced with a newer subscription, leaving out the newer one's overage subscription, interval, state and period", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx, { subscriptionId: "sub_newer", billingInterval: "annual" });
      const work = await asWorker(tx, (context) => loadPlanEndForPackWork(context, { businessId, subscriptionId: "sub_plan" }));
      expect(work).toEqual({ current: false, overageSubscriptionId: null, billingInterval: null, subscriptionState: null, periodEnd: null, switchedAt, pendingUsage: [], unsettled: 0 });
    });
  });

  it("answers null for a subscription the account doesn't name as replaced, as for every business that never switched", async () => {
    await rollbackTest(async (tx) => {
      const never = await business(tx, { replacedSubscriptionId: null, allowancesSince: null });
      const other = await business(tx, { replacedSubscriptionId: "sub_other" });
      await expect(asWorker(tx, (context) => loadPlanEndForPackWork(context, { businessId: never, subscriptionId: "sub_plan" }))).resolves.toBeNull();
      await expect(asWorker(tx, (context) => loadPlanEndForPackWork(context, { businessId: other, subscriptionId: "sub_plan" }))).resolves.toBeNull();
      await expect(asWorker(tx, (context) => loadPlanEndForPackWork(context, { businessId: randomUUID(), subscriptionId: "sub_plan" }))).resolves.toBeNull();
    });
  });

  it("lists the final Starter and Pro rows still to send, oldest first, and counts the rows not final yet that began by the switch", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const later = await usage(tx, businessId, { minutes: -60, plan: "pro" });
      const oldest = await usage(tx, businessId, { minutes: -180 });
      // A row with no plan of its own counted under the account's, Starter.
      const accountPlan = await usage(tx, businessId, { minutes: -120, usageKind: "alert_sms_segments", plan: null });
      // After the switch, as a call that began on the old plan and ended later; a newer subscription's row would look the same.
      const afterSwitch = await usage(tx, businessId, { minutes: 30, usageKind: "outbound_call_attempts" });
      // None of these go: already sent, a pack's or Free's, a chat (not overage), or not final yet.
      await usage(tx, businessId, { minutes: -170, syncStatus: "synced" });
      await usage(tx, businessId, { minutes: -160, plan: "prepaid", syncStatus: "skipped" });
      await usage(tx, businessId, { minutes: -150, plan: "free_cloud", syncStatus: "skipped" });
      await usage(tx, businessId, { minutes: -140, usageKind: "chat_ai_tokens" });
      // Unsettled: a call and a text estimate that began on Starter before the switch.
      await usage(tx, businessId, { minutes: -10, isFinal: false });
      await usage(tx, businessId, { minutes: 0, usageKind: "alert_sms_segments", isFinal: false });
      // Not unsettled: one that began after the switch, and a call on the pack.
      await usage(tx, businessId, { minutes: 5, isFinal: false });
      await usage(tx, businessId, { minutes: -5, plan: "prepaid", isFinal: false, syncStatus: "skipped" });
      // Another business's rows never count.
      const neighbour = await business(tx);
      await usage(tx, neighbour, { minutes: -30 });
      await usage(tx, neighbour, { minutes: -30, isFinal: false });

      const work = await asWorker(tx, (context) => loadPlanEndForPackWork(context, { businessId, subscriptionId: "sub_plan" }));
      expect(work).toMatchObject({ pendingUsage: [oldest, accountPlan, later, afterSwitch], unsettled: 2 });
    });
  });

  it("takes the switch's time from the job's payload over allowances_since, which a later switch moves, and ignores one that doesn't parse", async () => {
    await rollbackTest(async (tx) => {
      // A later switch back to a subscription moved allowances_since two hours on.
      const businessId = await business(tx, { allowancesSince: new Date(switchedAt.getTime() + 2 * HOUR) });
      await usage(tx, businessId, { minutes: 60, isFinal: false });
      const read = (since: string | undefined) => asWorker(tx, (context) => loadPlanEndForPackWork(context, { businessId, subscriptionId: "sub_plan", ...(since === undefined ? {} : { since }) }));
      await expect(read(switchedAt.toISOString())).resolves.toMatchObject({ switchedAt, unsettled: 0 });
      await expect(read("not a time")).resolves.toMatchObject({ switchedAt: new Date(switchedAt.getTime() + 2 * HOUR), unsettled: 1 });
      await expect(read(undefined)).resolves.toMatchObject({ switchedAt: new Date(switchedAt.getTime() + 2 * HOUR), unsettled: 1 });
    });
  });
});
