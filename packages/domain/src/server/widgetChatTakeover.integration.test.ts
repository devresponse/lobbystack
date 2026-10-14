import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { businessMemberships, businesses, conversations, createDatabaseClient, outboxMessages, users, widgetVisitors, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { appendMessage, findWidgetConversationId, getOrCreateWidgetConversation } from "./conversations";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Website chat integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

type Chat = Awaited<ReturnType<typeof seedChat>>;

/** Runs a test in one transaction and rolls it back, so other suites never see its rows. */
async function rollbackTest(run: (chat: Chat) => Promise<void>) {
  const rollback = new Error("rollback test fixture");
  try {
    await client!.db.transaction(async (tx) => {
      await run(await seedChat(tx));
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

/** Runs one step under the login production uses for it: the worker for the widget, the app for Messages. */
async function as<T>(tx: DatabaseTransaction, login: "worker" | "app", run: (db: Database) => Promise<T>): Promise<T> {
  await tx.execute(login === "worker" ? sql`set local session authorization lobbystack_worker` : sql`set local session authorization lobbystack_app`);
  try {
    return await run(tx as unknown as Database);
  } finally {
    await tx.execute(sql`reset session authorization`);
  }
}

/** A business with a team member, and a visitor whose website chat the AI is answering. */
async function seedChat(tx: DatabaseTransaction) {
  const businessId = randomUUID();
  const userId = randomUUID();
  const visitorId = randomUUID();
  await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "Javor", timezone: "UTC", businessType: "test", telemetryEnabled: false, deploymentMode: "self_hosted_standard" });
  await tx.insert(users).values({ id: userId, email: `${userId}@example.invalid`, normalizedEmail: `${userId}@example.invalid` });
  await tx.insert(businessMemberships).values({ businessId, userId, role: "business_owner" });
  await tx.insert(widgetVisitors).values({ id: visitorId, businessId });
  const { conversationId } = await as(tx, "worker", (db) => getOrCreateWidgetConversation({ db }, { businessId, widgetVisitorId: visitorId }));
  const write = (login: "worker" | "app", message: Omit<Parameters<typeof appendMessage>[1], "businessId" | "conversationId" | "channel">) =>
    as(tx, login, (db) => appendMessage({ db }, { ...message, businessId, conversationId, channel: "web_chat" }));
  return {
    businessId,
    userId,
    conversationId,
    visitorWrites: (body: string) => write("worker", { body, direction: "inbound" }),
    aiReplies: (body: string) => write("worker", { body, direction: "outbound", aiGenerated: true }),
    teamReplies: (body: string) => write("app", { body, direction: "outbound", userId }),
    async automation() {
      const [row] = await tx.select({ state: conversations.automationState, pausedBy: conversations.automationPausedByUserId, pausedAt: conversations.automationPausedAt }).from(conversations).where(eq(conversations.id, conversationId));
      return row!;
    },
    /** What the dashboard and the widget's live updates would hear. Rows from one transaction share a time, so in no set order. */
    async realtime() {
      const rows = await tx.select({ payload: outboxMessages.payload }).from(outboxMessages).where(and(eq(outboxMessages.businessId, businessId), eq(outboxMessages.topic, "realtime.publish")));
      return rows.map((row) => row.payload);
    },
    visitorId,
    findChat: (widgetVisitorId: string) => as(tx, "worker", (db) => findWidgetConversationId({ db }, { businessId, widgetVisitorId })),
    async addVisitor() {
      const id = randomUUID();
      await tx.insert(widgetVisitors).values({ id, businessId });
      return id;
    },
    async chatCount() {
      return (await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.businessId, businessId))).length;
    },
  };
}

describe.skipIf(!testUrl)("website chat take-over against PostgreSQL under production logins", () => {
  it("lets a team member's reply take the chat from the AI and tells the widget who wrote what", async () => {
    await rollbackTest(async (chat) => {
      const asked = await chat.visitorWrites("Can I talk to someone?");
      const answered = await chat.aiReplies("Let me see who's around.");
      expect(await chat.automation()).toMatchObject({ state: "ai_active", pausedBy: null });

      const joined = await chat.teamReplies("Hi, this is Yuri. How can I help?");
      const takenOver = await chat.automation();
      expect(takenOver).toMatchObject({ state: "human_handoff", pausedBy: chat.userId });
      expect(takenOver.pausedAt).toBeInstanceOf(Date);

      // A second reply keeps the take-over as it was and doesn't announce it again.
      await chat.teamReplies("Are you still there?");
      expect(await chat.automation()).toEqual(takenOver);

      const events = await chat.realtime();
      const messageEvents = events.filter((event) => event.type === "message.upserted");
      expect(messageEvents).toHaveLength(4);
      expect(messageEvents).toEqual(expect.arrayContaining([
        { type: "message.upserted", entityId: asked, conversationId: chat.conversationId, direction: "inbound", aiGenerated: false },
        { type: "message.upserted", entityId: answered, conversationId: chat.conversationId, direction: "outbound", aiGenerated: true },
        { type: "message.upserted", entityId: joined, conversationId: chat.conversationId, direction: "outbound", aiGenerated: false },
      ]));
      expect(events.filter((event) => event.type === "conversation.updated")).toEqual([{ type: "conversation.updated", entityId: chat.conversationId }]);
    });
  });

  it("finds a visitor's open chat for the widget's live updates without ever creating one", async () => {
    await rollbackTest(async (chat) => {
      expect(await chat.findChat(chat.visitorId)).toBe(chat.conversationId);
      const newcomer = await chat.addVisitor();
      expect(await chat.findChat(newcomer)).toBeNull();
      expect(await chat.chatCount()).toBe(1);
    });
  });
});
