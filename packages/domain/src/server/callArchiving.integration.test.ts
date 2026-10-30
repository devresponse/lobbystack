import { randomUUID } from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { auditLogs, businessMemberships, businesses, calls, contacts, conversations, createDatabaseClient, outboxMessages, transcripts, users, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { getContactDetail } from "./contacts";
import { listRecentCalls } from "./operatorActivity";
import { getCallDetail, listCalls, setCallArchived } from "./voice";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Call archiving integration tests require a dedicated local test database.");
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

/** A business with a member of each role, a caller with two calls, and another business's call. */
async function seed(tx: DatabaseTransaction) {
  const businessId = randomUUID();
  const otherBusinessId = randomUUID();
  const userIds = { owner: randomUUID(), admin: randomUUID(), scheduler: randomUUID(), viewer: randomUUID() };
  await tx.insert(businesses).values([
    { id: businessId, slug: businessId, name: "Call archiving test", timezone: "UTC", businessType: "test", telemetryEnabled: false },
    { id: otherBusinessId, slug: otherBusinessId, name: "Another business", timezone: "UTC", businessType: "test", telemetryEnabled: false },
  ]);
  for (const [role, id] of Object.entries(userIds)) {
    await tx.insert(users).values({ id, email: `${id}@example.invalid`, normalizedEmail: `${id}@example.invalid` });
    await tx.insert(businessMemberships).values({ businessId, userId: id, role: role === "owner" ? "business_owner" : role === "admin" ? "business_admin" : role });
  }
  const contactId = randomUUID();
  await tx.insert(contacts).values({ id: contactId, businessId, name: "Marie Tremblay", phone: "+14155550100" });
  const call = async (business: string, minutesAgo: number, transport = "voice") => {
    const conversationId = randomUUID();
    await tx.insert(conversations).values({ id: conversationId, businessId: business, ...(business === businessId ? { contactId } : {}), channel: "voice" });
    const [row] = await tx.insert(calls).values({ businessId: business, conversationId, ...(business === businessId ? { contactId } : {}), provider: "openai_live", providerCallId: `rtc_${randomUUID()}`, transport, status: "completed", startedAt: new Date(Date.now() - minutesAgo * 60_000), endedAt: new Date(Date.now() - minutesAgo * 60_000 + 15_000) }).returning({ id: calls.id });
    return row!.id;
  };
  const testCall = await call(businessId, 10, "web_voice");
  const realCall = await call(businessId, 60);
  const otherCall = await call(otherBusinessId, 5);
  await tx.insert(transcripts).values([
    { businessId, callId: testCall, sequence: 1, speaker: "assistant", text: "Thank you for calling. How can I help you?" },
    { businessId, callId: testCall, sequence: 2, speaker: "caller", text: "Just testing the elevator booking." },
  ]);
  await tx.execute(sql`set local role lobbystack_app`);
  const db = tx as unknown as Database;
  const asMigrator = async <T>(run: () => Promise<T>) => {
    await tx.execute(sql`reset role`);
    try { return await run(); } finally { await tx.execute(sql`set local role lobbystack_app`); }
  };
  const archive = (userId: string, callId: string, archived = true, business = businessId) => setCallArchived({ db }, { userId, businessId: business, callId, archived });
  return { db, businessId, otherBusinessId, userIds, contactId, testCall, realCall, otherCall, asMigrator, archive };
}

describe.skipIf(!client)("archiving a call under operator RLS", () => {
  it("takes the call out of the Calls list and Home, and keeps it, its transcript and its page", async () => {
    await rollbackTest(async (tx) => {
      const { db, businessId, userIds, contactId, testCall, realCall, asMigrator, archive } = await seed(tx);
      const owner = { userId: userIds.owner, businessId };
      expect((await listCalls({ db }, owner)).calls.map((call) => call.id)).toEqual([testCall, realCall]);

      const archived = await archive(userIds.owner, testCall);
      expect(archived?.archivedAt).toBeInstanceOf(Date);

      const listed = await listCalls({ db }, owner);
      expect(listed.calls.map((call) => call.id)).toEqual([realCall]);
      expect(listed.pagination.total).toBe(1);
      // A search for its words doesn't bring it back either.
      expect((await listCalls({ db }, { ...owner, search: "elevator" })).calls).toEqual([]);
      await withBusinessTransaction(db, { ...owner, actorType: "operator" }, async (appTx) => {
        expect((await listRecentCalls(appTx, businessId)).map((call) => call.id)).toEqual([realCall]);
      });

      // Its page still opens, with the whole transcript.
      const detail = await getCallDetail({ db }, { ...owner, callId: testCall });
      expect(detail?.call).toMatchObject({ id: testCall, archivedAt: archived!.archivedAt });
      expect(detail?.transcript.map((line) => line.text)).toEqual(["Thank you for calling. How can I help you?", "Just testing the elevator booking."]);
      expect((await getCallDetail({ db }, { ...owner, callId: realCall }))?.call.archivedAt).toBeNull();

      // The contact's history keeps both calls, the archived one marked.
      const contact = await getContactDetail({ db }, { ...owner, contactId });
      expect(contact.calls.map((call) => [call.id, call.archivedAt])).toEqual([[testCall, archived!.archivedAt], [realCall, null]]);
      expect(contact.activityCounts.calls).toBe(2);

      await asMigrator(async () => {
        expect((await tx.select({ lines: count() }).from(transcripts).where(eq(transcripts.callId, testCall)))[0]?.lines).toBe(2);
        expect(await tx.select({ actorUserId: auditLogs.actorUserId, eventType: auditLogs.eventType, entityType: auditLogs.entityType }).from(auditLogs).where(eq(auditLogs.entityId, testCall))).toEqual([{ actorUserId: userIds.owner, eventType: "call.archived", entityType: "call" }]);
        // Other open dashboards hear about it and drop the call from their lists.
        const published = await tx.select({ payload: outboxMessages.payload }).from(outboxMessages).where(and(eq(outboxMessages.aggregateId, testCall), eq(outboxMessages.topic, "realtime.publish")));
        expect(published.map((message) => message.payload)).toEqual([expect.objectContaining({ type: "call.updated", entityId: testCall })]);
      });
    });
  });

  it("puts a restored call back in the list", async () => {
    await rollbackTest(async (tx) => {
      const { db, businessId, userIds, testCall, realCall, asMigrator, archive } = await seed(tx);
      await archive(userIds.owner, testCall);
      expect(await archive(userIds.admin, testCall, false)).toEqual({ archivedAt: null });
      expect((await listCalls({ db }, { userId: userIds.owner, businessId })).calls.map((call) => call.id)).toEqual([testCall, realCall]);
      await asMigrator(async () => {
        const entries = await tx.select({ actorUserId: auditLogs.actorUserId, eventType: auditLogs.eventType }).from(auditLogs).where(eq(auditLogs.entityId, testCall));
        expect(entries).toEqual(expect.arrayContaining([{ actorUserId: userIds.owner, eventType: "call.archived" }, { actorUserId: userIds.admin, eventType: "call.restored" }]));
        // Each change publishes its own update.
        expect((await tx.select({ messages: count() }).from(outboxMessages).where(and(eq(outboxMessages.aggregateId, testCall), eq(outboxMessages.topic, "realtime.publish"))))[0]?.messages).toBe(2);
      });
    });
  });

  it("keeps the first archive time when a call is archived again", async () => {
    await rollbackTest(async (tx) => {
      const { userIds, testCall, asMigrator, archive } = await seed(tx);
      const firstArchived = new Date("2026-10-01T12:00:00Z");
      await asMigrator(() => tx.update(calls).set({ archivedAt: firstArchived }).where(eq(calls.id, testCall)));
      expect(await archive(userIds.owner, testCall)).toEqual({ archivedAt: firstArchived });
    });
  });

  it("lets only owners and admins archive or restore", async () => {
    await rollbackTest(async (tx) => {
      const { db, businessId, userIds, testCall, realCall, archive } = await seed(tx);
      for (const userId of [userIds.scheduler, userIds.viewer]) {
        await expect(archive(userId, testCall)).rejects.toMatchObject({ status: 403, code: "forbidden" });
      }
      expect((await listCalls({ db }, { userId: userIds.viewer, businessId })).calls.map((call) => call.id)).toEqual([testCall, realCall]);
      await archive(userIds.admin, testCall);
      await expect(archive(userIds.scheduler, testCall, false)).rejects.toMatchObject({ status: 403 });
      expect((await listCalls({ db }, { userId: userIds.scheduler, businessId })).calls.map((call) => call.id)).toEqual([realCall]);
    });
  });

  it("can't reach another business's call", async () => {
    await rollbackTest(async (tx) => {
      const { userIds, otherBusinessId, otherCall, asMigrator, archive } = await seed(tx);
      expect(await archive(userIds.owner, otherCall)).toBeNull();
      // Nor by naming the other business, which the owner isn't a member of.
      await expect(archive(userIds.owner, otherCall, true, otherBusinessId)).rejects.toMatchObject({ status: 403 });
      await asMigrator(async () => {
        expect((await tx.select({ archivedAt: calls.archivedAt }).from(calls).where(eq(calls.id, otherCall)))[0]?.archivedAt).toBeNull();
      });
    });
  });
});
