import { randomUUID } from "node:crypto";

import { and, eq, inArray, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { billingAccounts, billingCheckoutRequests, billingUsageEvents, businesses, createDatabaseClient, outboxMessages, providerEvents, users, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { BILLING_CHECKOUT_CLAIM_STALE_MS, claimBillingCheckoutRequest, releaseBillingCheckoutRequest } from "./billing";
import { storePolarWebhookEvent, sweepBillingWork } from "./billingSweep";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Reliability integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

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

// The sweep runs at a time long before any other row in the database, so it
// finds only this file's rows.
const now = new Date("2001-03-01T12:30:00Z");
const ago = (minutes: number, from = now) => new Date(from.getTime() - minutes * 60_000);

async function business(tx: DatabaseTransaction, input: { customer?: boolean } = {}) {
  const businessId = randomUUID();
  await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "Billing sweep test", timezone: "UTC", businessType: "test", telemetryEnabled: false });
  await tx.insert(billingAccounts).values({ businessId, billingKey: `business:${businessId}`, plan: "starter", subscriptionState: "active", billingInterval: "month", customerId: input.customer === false ? null : `cus_${businessId}` });
  return businessId;
}

async function owner(tx: DatabaseTransaction) {
  const id = randomUUID();
  await tx.insert(users).values({ id, email: `${id}@example.invalid`, normalizedEmail: `${id}@example.invalid` });
  return id;
}

async function event(tx: DatabaseTransaction, businessId: string, input: { minutes: number; status?: string; provider?: string }) {
  const [row] = await tx.insert(providerEvents).values({ provider: input.provider ?? "polar", providerEventId: `evt_${randomUUID()}`, eventType: "subscription.active", businessId, payload: {}, status: input.status ?? "received", createdAt: ago(input.minutes), updatedAt: ago(input.minutes) }).returning({ id: providerEvents.id });
  return row!.id;
}

async function usage(tx: DatabaseTransaction, businessId: string, input: { minutes: number; isFinal?: boolean; usageKind?: string; syncStatus?: string }) {
  const [row] = await tx.insert(billingUsageEvents).values({ businessId, periodKey: "2001-03", sourceKey: `voice:${randomUUID()}`, usageKind: input.usageKind ?? "voice_seconds", quantity: 60, planAtRecordTime: "starter", isFinal: input.isFinal ?? true, syncStatus: input.syncStatus ?? "pending", createdAt: ago(input.minutes + 1), updatedAt: ago(input.minutes) }).returning({ id: billingUsageEvents.id });
  return row!.id;
}

async function checkout(tx: DatabaseTransaction, businessId: string, input: { userId: string; created: number; updated?: number; status?: string; at?: Date }) {
  const at = input.at ?? now;
  const [row] = await tx.insert(billingCheckoutRequests).values({ businessId, requestedByUserId: input.userId, target: "pro", billingInterval: "monthly", status: input.status ?? "pending", createdAt: ago(input.created, at), updatedAt: ago(input.updated ?? input.created, at) }).returning({ id: billingCheckoutRequests.id });
  return row!.id;
}

/** The jobs the sweep queued for these rows, by aggregate id. */
async function sweepJobs(tx: DatabaseTransaction, ids: string[]) {
  const rows = await tx.select({ topic: outboxMessages.topic, aggregateId: outboxMessages.aggregateId, dedupeKey: outboxMessages.dedupeKey, payload: outboxMessages.payload }).from(outboxMessages).where(and(inArray(outboxMessages.aggregateId, ids), like(outboxMessages.dedupeKey, "billing-sweep:%")));
  return rows.sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey));
}

async function asWorkerLogin<T>(tx: DatabaseTransaction, run: (context: { db: Database }) => Promise<T>): Promise<T> {
  // The listing trusts only the worker's login identity.
  await tx.execute(sql`set local session authorization lobbystack_worker`);
  const result = await run({ db: tx as unknown as Database });
  await tx.execute(sql`reset session authorization`);
  return result;
}

describe.skipIf(!testUrl)("the billing sweep against PostgreSQL", () => {
  it("queues the billing work no job finished, in each business's scope, and fails checkouts that waited too long", async () => {
    await rollbackTest(async (tx) => {
      const paying = await business(tx);
      const other = await business(tx);
      const noCustomer = await business(tx, { customer: false });
      const userId = await owner(tx);
      const lostEvent = await event(tx, paying, { minutes: 10 });
      const oldEvent = await event(tx, other, { minutes: 120 });
      const lostUsage = await usage(tx, paying, { minutes: 30 });
      const oldUsage = await usage(tx, other, { minutes: 120 });
      const lostCheckout = await checkout(tx, paying, { userId, created: 8 });
      const diedCheckout = await checkout(tx, other, { userId, created: 9, updated: 6, status: "processing" });
      const abandoned = await checkout(tx, paying, { userId, created: 20 });
      const waiting = [
        await event(tx, paying, { minutes: 2 }),
        await event(tx, paying, { minutes: 10, status: "processed" }),
        await event(tx, paying, { minutes: 10, provider: "resend" }),
        await usage(tx, paying, { minutes: 5 }),
        await usage(tx, paying, { minutes: 30, isFinal: false }),
        await usage(tx, paying, { minutes: 30, usageKind: "chat_ai_tokens" }),
        await usage(tx, paying, { minutes: 30, syncStatus: "synced" }),
        await usage(tx, noCustomer, { minutes: 30 }),
        await checkout(tx, paying, { userId, created: 9, updated: 2, status: "processing" }),
        await checkout(tx, paying, { userId, created: 9, status: "ready" }),
        await checkout(tx, paying, { userId, created: 30, status: "error" }),
      ];

      const outcome = await asWorkerLogin(tx, (context) => sweepBillingWork(context, now));

      expect(outcome).toEqual({ queued: { provider_event: 2, usage_event: 2, checkout_request: 2 }, overdue: { provider_event: 1, usage_event: 1, checkout_request: 1 }, failed: 0 });
      const hour = Math.floor(now.getTime() / 3_600_000);
      expect(await sweepJobs(tx, [lostEvent, oldEvent, lostUsage, oldUsage, lostCheckout, diedCheckout, abandoned, ...waiting])).toEqual([
        { topic: "billing.createCheckout", aggregateId: lostCheckout, dedupeKey: `billing-sweep:checkout_request:${lostCheckout}:${hour}`, payload: { requestId: lostCheckout } },
        { topic: "billing.createCheckout", aggregateId: diedCheckout, dedupeKey: `billing-sweep:checkout_request:${diedCheckout}:${hour}`, payload: { requestId: diedCheckout } },
        { topic: "billing.reconcile", aggregateId: lostEvent, dedupeKey: `billing-sweep:provider_event:${lostEvent}:${hour}`, payload: { providerEventId: lostEvent } },
        { topic: "billing.reconcile", aggregateId: oldEvent, dedupeKey: `billing-sweep:provider_event:${oldEvent}:${hour}`, payload: { providerEventId: oldEvent } },
        { topic: "billing.syncUsage", aggregateId: lostUsage, dedupeKey: `billing-sweep:usage_event:${lostUsage}:${hour}`, payload: { usageEventId: lostUsage } },
        { topic: "billing.syncUsage", aggregateId: oldUsage, dedupeKey: `billing-sweep:usage_event:${oldUsage}:${hour}`, payload: { usageEventId: oldUsage } },
      ].sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey)));
      // Each job runs in its row's business.
      const scopes = await tx.select({ aggregateId: outboxMessages.aggregateId, businessId: outboxMessages.businessId }).from(outboxMessages).where(inArray(outboxMessages.aggregateId, [lostEvent, oldEvent]));
      expect(new Map(scopes.map((row) => [row.aggregateId, row.businessId]))).toEqual(new Map([[lostEvent, paying], [oldEvent, other]]));

      // A request nobody could still be waiting on fails, and its page hears so.
      const [closed] = await tx.select({ status: billingCheckoutRequests.status, error: billingCheckoutRequests.error }).from(billingCheckoutRequests).where(eq(billingCheckoutRequests.id, abandoned));
      expect(closed).toEqual({ status: "error", error: "This request waited too long to run." });
      expect(await tx.select({ topic: outboxMessages.topic, dedupeKey: outboxMessages.dedupeKey }).from(outboxMessages).where(eq(outboxMessages.aggregateId, abandoned))).toEqual([{ topic: "realtime.publish", dedupeKey: `billing-checkout:${abandoned}:error` }]);
    });
  });

  it("queues each row at most once an hour, so work that keeps failing doesn't hide the rows behind it", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const userId = await owner(tx);
      const lostEvent = await event(tx, businessId, { minutes: 10 });
      const lostUsage = await usage(tx, businessId, { minutes: 30 });
      const lostCheckout = await checkout(tx, businessId, { userId, created: 8 });

      const none = { provider_event: 0, usage_event: 0, checkout_request: 0 };
      const first = await asWorkerLogin(tx, (context) => sweepBillingWork(context, now));
      expect(first.queued).toEqual({ provider_event: 1, usage_event: 1, checkout_request: 1 });
      // A few minutes later the same hour's jobs stand.
      const again = await asWorkerLogin(tx, (context) => sweepBillingWork(context, new Date(now.getTime() + 5 * 60_000)));
      expect(again).toEqual({ queued: none, overdue: none, failed: 0 });
      // Once the checkout has waited too long, a sweep in the same hour fails it all the same.
      const expired = await asWorkerLogin(tx, (context) => sweepBillingWork(context, new Date(now.getTime() + 10 * 60_000)));
      expect(expired).toEqual({ queued: none, overdue: { ...none, checkout_request: 1 }, failed: 0 });

      // The next hour queues the event and usage again.
      const nextHour = new Date(now.getTime() + 60 * 60_000);
      const later = await asWorkerLogin(tx, (context) => sweepBillingWork(context, nextHour));
      expect(later).toEqual({ queued: { ...none, provider_event: 1, usage_event: 1 }, overdue: { ...none, provider_event: 1, usage_event: 1 }, failed: 0 });
      const [hour, next] = [now, nextHour].map((at) => Math.floor(at.getTime() / 3_600_000));
      expect((await sweepJobs(tx, [lostEvent, lostUsage, lostCheckout])).map((job) => {
        const [, kind, , queuedHour] = job.dedupeKey.split(":");
        return `${kind}:${queuedHour}`;
      })).toEqual([`checkout_request:${hour}`, `provider_event:${hour}`, `provider_event:${next}`, `usage_event:${hour}`, `usage_event:${next}`]);
    });
  });

  it("lets only the worker's login list billing work", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      await event(tx, businessId, { minutes: 10 });
      const list = sql`select count(*)::int as count from app.list_billing_sweep_work(${ago(5).toISOString()}::timestamptz, ${ago(15).toISOString()}::timestamptz, ${ago(5).toISOString()}::timestamptz, ${ago(15).toISOString()}::timestamptz, 0, 10)`;
      // The worker's login without the worker's actor type lists nothing.
      await tx.execute(sql`set local session authorization lobbystack_worker`);
      await tx.execute(sql`select set_config('app.actor_type', 'operator', true)`);
      expect((await tx.execute<{ count: number }>(list)).rows[0]!.count).toBe(0);
      await tx.execute(sql`select set_config('app.actor_type', 'worker', true)`);
      expect((await tx.execute<{ count: number }>(list)).rows[0]!.count).toBe(1);
      await tx.execute(sql`reset session authorization`);
      // The app role can't call it. A savepoint keeps the fixture transaction usable.
      await tx.execute(sql`set local session authorization lobbystack_app`);
      await expect(tx.transaction((inner) => inner.execute(list))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
      await tx.execute(sql`reset session authorization`);
    });
  });

  it("claims a checkout once, hands it back for a retry, takes over one whose run died, and fails one that waited too long", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const userId = await owner(tx);
      const real = new Date();
      const fresh = await checkout(tx, businessId, { userId, created: 1, at: real });
      const died = await checkout(tx, businessId, { userId, created: 7, updated: 6, status: "processing", at: real });
      const stale = await checkout(tx, businessId, { userId, created: 20, at: real });
      const failed = await checkout(tx, businessId, { userId, created: 2, status: "error", at: real });
      const context = { db: tx as unknown as Database };
      const status = async (id: string) => (await tx.select({ status: billingCheckoutRequests.status }).from(billingCheckoutRequests).where(eq(billingCheckoutRequests.id, id)))[0]!.status;
      await tx.execute(sql`set local role lobbystack_worker`);

      expect(await claimBillingCheckoutRequest(context, { businessId, requestId: fresh })).toEqual({ claimed: true });
      // Another run waits until this one's claim could have gone stale.
      const held = await claimBillingCheckoutRequest(context, { businessId, requestId: fresh });
      expect(held.claimed).toBe(false);
      const retryAt = (held as { retryAt: Date }).retryAt.getTime();
      expect(retryAt).toBeGreaterThan(Date.now() + BILLING_CHECKOUT_CLAIM_STALE_MS - 60_000);
      expect(retryAt).toBeLessThanOrEqual(Date.now() + BILLING_CHECKOUT_CLAIM_STALE_MS);
      // A try that will be retried hands it back, and the next try claims it.
      expect(await releaseBillingCheckoutRequest(context, { businessId, requestId: fresh })).toBe(true);
      expect(await status(fresh)).toBe("pending");
      expect(await claimBillingCheckoutRequest(context, { businessId, requestId: fresh })).toEqual({ claimed: true });

      expect(await claimBillingCheckoutRequest(context, { businessId, requestId: died })).toEqual({ claimed: true });
      expect(await claimBillingCheckoutRequest(context, { businessId, requestId: stale })).toEqual({ claimed: false, retryAt: null, expired: true });
      expect(await status(stale)).toBe("error");
      // A failure stands.
      expect(await claimBillingCheckoutRequest(context, { businessId, requestId: failed })).toEqual({ claimed: false, retryAt: null });
      expect(await status(failed)).toBe("error");
      await tx.execute(sql`reset role`);
    });
  });

  it("stores a Polar delivery once, and queues one that never applied again when Polar sends it again, at most once an hour", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const providerEventId = `evt_${randomUUID()}`;
      // The webhook stores each delivery as the worker, in the event's business.
      const store = async (at: Date) => {
        await tx.execute(sql`set local role lobbystack_worker`);
        const isNew = await withBusinessTransaction(tx as unknown as Database, { businessId, actorType: "worker" }, async (inner) => await storePolarWebhookEvent(inner, { businessId, providerEventId, eventType: "subscription.active", payload: { plan: "starter" }, now: at }));
        await tx.execute(sql`reset role`);
        return isNew;
      };
      const jobs = async () => (await tx.select({ dedupeKey: outboxMessages.dedupeKey, payload: outboxMessages.payload }).from(outboxMessages).where(eq(outboxMessages.businessId, businessId))).sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey));

      expect(await store(now)).toBe(true);
      const [stored] = await tx.select({ id: providerEvents.id, status: providerEvents.status }).from(providerEvents).where(eq(providerEvents.providerEventId, providerEventId));
      expect(stored?.status).toBe("received");
      const eventId = stored!.id;
      const [hour, next] = [now, new Date(now.getTime() + 60 * 60_000)].map((at) => Math.floor(at.getTime() / 3_600_000));
      // Polar sends it twice more in the hour, and its first job never applied it.
      expect(await store(now)).toBe(false);
      expect(await store(new Date(now.getTime() + 5 * 60_000))).toBe(false);
      expect(await jobs()).toEqual([
        { dedupeKey: `billing-sweep:provider_event:${eventId}:${hour}`, payload: { providerEventId: eventId } },
        { dedupeKey: `provider-event:${providerEventId}:billing`, payload: { providerEventId: eventId } },
      ]);
      // Once it applied, Polar's next delivery is only a duplicate.
      await tx.update(providerEvents).set({ status: "processed" }).where(eq(providerEvents.id, eventId));
      expect(await store(new Date(now.getTime() + 60 * 60_000))).toBe(false);
      expect((await jobs()).map((job) => job.dedupeKey)).not.toContain(`billing-sweep:provider_event:${eventId}:${next}`);
      expect(await tx.select({ id: providerEvents.id }).from(providerEvents).where(eq(providerEvents.providerEventId, providerEventId))).toHaveLength(1);
    });
  });
});
