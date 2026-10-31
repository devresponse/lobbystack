import { randomInt, randomUUID } from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { auditLogs, businessMemberships, businesses, contacts, conversations, createDatabaseClient, messages, outboxMessages, phoneNumbers, users, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { appendMessage, setConversationArchived } from "./conversations";
import { listHandoffConversations } from "./operatorActivity";
import { receiveInboundSms } from "./sms";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Conversation archiving integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

const digits = (count: number) => String(randomInt(0, 10 ** count)).padStart(count, "0");

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

/** Runs one step under the login production uses for it: the worker for webhooks and the receptionist, the app for the dashboard. */
async function as<T>(tx: DatabaseTransaction, login: "worker" | "app", run: (db: Database) => Promise<T>): Promise<T> {
  await tx.execute(login === "worker" ? sql`set local session authorization lobbystack_worker` : sql`set local session authorization lobbystack_app`);
  try {
    return await run(tx as unknown as Database);
  } finally {
    await tx.execute(sql`reset session authorization`);
  }
}

/**
 * A business with a member of each role and its own SMS number, a customer's
 * text conversation, a website chat the team took over, and another business's
 * conversation.
 */
async function seed(tx: DatabaseTransaction) {
  const businessId = randomUUID();
  const otherBusinessId = randomUUID();
  const number = `+1437${digits(7)}`;
  const customerPhone = `+1647${digits(7)}`;
  await tx.insert(businesses).values([
    { id: businessId, slug: businessId, name: "Conversation archiving test", timezone: "UTC", businessType: "test", telemetryEnabled: false, deploymentMode: "self_hosted_standard" },
    { id: otherBusinessId, slug: otherBusinessId, name: "Another business", timezone: "UTC", businessType: "test", telemetryEnabled: false },
  ]);
  const userIds = { owner: randomUUID(), admin: randomUUID(), scheduler: randomUUID(), viewer: randomUUID() };
  for (const [role, id] of Object.entries(userIds)) {
    await tx.insert(users).values({ id, email: `${id}@example.invalid`, normalizedEmail: `${id}@example.invalid` });
    await tx.insert(businessMemberships).values({ businessId, userId: id, role: role === "owner" ? "business_owner" : role === "admin" ? "business_admin" : role });
  }
  await tx.insert(phoneNumbers).values({ businessId, e164: number, providerPhoneId: `PN-${randomUUID()}` });
  const contactId = randomUUID();
  await tx.insert(contacts).values({ id: contactId, businessId, name: "Marie Tremblay", phone: customerPhone });
  const textConversation = randomUUID(), chatConversation = randomUUID(), otherConversation = randomUUID();
  const lastActive = new Date("2026-10-30T12:00:00Z");
  await tx.insert(conversations).values([
    { id: textConversation, businessId, contactId, channel: "sms", updatedAt: lastActive },
    { id: chatConversation, businessId, contactId, channel: "web_chat", automationState: "human_handoff", summary: "Asked for a person about a quote." },
    { id: otherConversation, businessId: otherBusinessId, channel: "sms" },
  ]);
  await tx.insert(messages).values([
    { businessId, conversationId: textConversation, direction: "inbound", channel: "sms", body: "Can you call me back?", status: "received" },
    { businessId, conversationId: chatConversation, direction: "inbound", channel: "web_chat", body: "Can I talk to someone?", status: "received" },
  ]);
  const archive = (userId: string, conversationId: string, archived = true, business = businessId) => as(tx, "app", (db) => setConversationArchived({ db }, { userId, businessId: business, conversationId, archived }));
  const archivedAt = async (conversationId: string) => (await tx.select({ archivedAt: conversations.archivedAt }).from(conversations).where(eq(conversations.id, conversationId)))[0]?.archivedAt ?? null;
  return { businessId, otherBusinessId, number, customerPhone, userIds, textConversation, chatConversation, otherConversation, lastActive, archive, archivedAt };
}

describe.skipIf(!client)("archiving a conversation under operator RLS", () => {
  it("hides it and deletes nothing: its messages and its place stay, and the change is on record", async () => {
    await rollbackTest(async (tx) => {
      const { userIds, textConversation, lastActive, archive, archivedAt } = await seed(tx);

      const archived = await archive(userIds.owner, textConversation);
      expect(archived?.archivedAt).toBeInstanceOf(Date);
      expect(await archivedAt(textConversation)).toEqual(archived!.archivedAt);

      const [conversation] = await tx.select({ updatedAt: conversations.updatedAt, status: conversations.status }).from(conversations).where(eq(conversations.id, textConversation));
      // updatedAt picks a contact's current conversation, so archiving leaves it as it was.
      expect(conversation).toEqual({ updatedAt: lastActive, status: "open" });
      expect((await tx.select({ messages: count() }).from(messages).where(eq(messages.conversationId, textConversation)))[0]?.messages).toBe(1);
      expect(await tx.select({ actorUserId: auditLogs.actorUserId, eventType: auditLogs.eventType, entityType: auditLogs.entityType }).from(auditLogs).where(eq(auditLogs.entityId, textConversation))).toEqual([{ actorUserId: userIds.owner, eventType: "conversation.archived", entityType: "conversation" }]);
      // Other open dashboards hear about it and drop the conversation from their lists.
      const published = await tx.select({ payload: outboxMessages.payload }).from(outboxMessages).where(and(eq(outboxMessages.aggregateId, textConversation), eq(outboxMessages.topic, "realtime.publish")));
      expect(published.map((message) => message.payload)).toEqual([expect.objectContaining({ type: "conversation.updated", entityId: textConversation })]);
    });
  });

  it("puts a restored conversation back, and records who restored it", async () => {
    await rollbackTest(async (tx) => {
      const { userIds, textConversation, archive, archivedAt } = await seed(tx);
      await archive(userIds.owner, textConversation);
      expect(await archive(userIds.admin, textConversation, false)).toEqual({ archivedAt: null });
      expect(await archivedAt(textConversation)).toBeNull();
      const entries = await tx.select({ actorUserId: auditLogs.actorUserId, eventType: auditLogs.eventType }).from(auditLogs).where(eq(auditLogs.entityId, textConversation));
      expect(entries).toEqual(expect.arrayContaining([{ actorUserId: userIds.owner, eventType: "conversation.archived" }, { actorUserId: userIds.admin, eventType: "conversation.restored" }]));
      // Each change publishes its own update.
      expect((await tx.select({ messages: count() }).from(outboxMessages).where(and(eq(outboxMessages.aggregateId, textConversation), eq(outboxMessages.topic, "realtime.publish"))))[0]?.messages).toBe(2);
    });
  });

  it("keeps the first archive time when a conversation is archived again", async () => {
    await rollbackTest(async (tx) => {
      const { userIds, textConversation, archive } = await seed(tx);
      const firstArchived = new Date("2026-10-01T12:00:00Z");
      await tx.update(conversations).set({ archivedAt: firstArchived }).where(eq(conversations.id, textConversation));
      expect(await archive(userIds.owner, textConversation)).toEqual({ archivedAt: firstArchived });
    });
  });

  it("lets only owners and admins archive or restore", async () => {
    await rollbackTest(async (tx) => {
      const { userIds, textConversation, archive, archivedAt } = await seed(tx);
      for (const userId of [userIds.scheduler, userIds.viewer]) {
        await expect(archive(userId, textConversation)).rejects.toMatchObject({ status: 403, code: "forbidden" });
      }
      expect(await archivedAt(textConversation)).toBeNull();
      await archive(userIds.admin, textConversation);
      await expect(archive(userIds.scheduler, textConversation, false)).rejects.toMatchObject({ status: 403 });
      expect(await archivedAt(textConversation)).toBeInstanceOf(Date);
    });
  });

  it("can't reach another business's conversation", async () => {
    await rollbackTest(async (tx) => {
      const { userIds, otherBusinessId, otherConversation, archive, archivedAt } = await seed(tx);
      expect(await archive(userIds.owner, otherConversation)).toBeNull();
      // Nor by naming the other business, which the owner isn't a member of.
      await expect(archive(userIds.owner, otherConversation, true, otherBusinessId)).rejects.toMatchObject({ status: 403 });
      expect(await archivedAt(otherConversation)).toBeNull();
    });
  });

  it("leaves Home's Action required, and comes back on it once restored", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userIds, chatConversation, archive } = await seed(tx);
      const handoffs = () => as(tx, "app", (db) => withBusinessTransaction(db, { userId: userIds.owner, businessId, actorType: "operator" }, async (appTx) => (await listHandoffConversations(appTx, businessId)).map((row) => row.id)));
      expect(await handoffs()).toEqual([chatConversation]);
      await archive(userIds.owner, chatConversation);
      expect(await handoffs()).toEqual([]);
      await archive(userIds.owner, chatConversation, false);
      expect(await handoffs()).toEqual([chatConversation]);
    });
  });
});

describe.skipIf(!client)("a new message in an archived conversation", () => {
  it("brings it back when the customer texts again", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, number, customerPhone, userIds, textConversation, archive, archivedAt } = await seed(tx);
      await archive(userIds.owner, textConversation);
      await as(tx, "worker", (db) => receiveInboundSms({ db }, { businessId, providerMessageId: `SM${randomUUID()}`, from: customerPhone, to: number, body: "Are you open Saturday?", payload: {} }));
      expect(await archivedAt(textConversation)).toBeNull();
      expect((await tx.select({ messages: count() }).from(messages).where(eq(messages.conversationId, textConversation)))[0]?.messages).toBe(2);
    });
  });

  it("brings it back when a website visitor writes, or the receptionist takes a message in it", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userIds, textConversation, chatConversation, archive, archivedAt } = await seed(tx);
      await archive(userIds.owner, chatConversation);
      await as(tx, "worker", (db) => appendMessage({ db }, { businessId, conversationId: chatConversation, body: "Hello? Anyone there?", direction: "inbound", channel: "web_chat" }));
      expect(await archivedAt(chatConversation)).toBeNull();

      await archive(userIds.owner, textConversation);
      await as(tx, "worker", (db) => appendMessage({ db }, { businessId, conversationId: textConversation, body: "Marie called: please call her back.", direction: "inbound", channel: "dashboard" }));
      expect(await archivedAt(textConversation)).toBeNull();
    });
  });

  it("brings it back when someone from the team replies in it", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userIds, chatConversation, archive, archivedAt } = await seed(tx);
      await archive(userIds.owner, chatConversation);
      await as(tx, "app", (db) => appendMessage({ db }, { userId: userIds.scheduler, businessId, conversationId: chatConversation, body: "Hi, I can help with the quote.", direction: "outbound", channel: "web_chat" }));
      expect(await archivedAt(chatConversation)).toBeNull();
    });
  });
});
