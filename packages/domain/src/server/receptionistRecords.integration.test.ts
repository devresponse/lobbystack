import { randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  billingAccounts,
  businesses,
  calls,
  checkReceptionistData,
  conversations,
  createDatabaseClient,
  fillDefaultReceptionistBatch,
  inboxItems,
  knowledgeSnippetReceptionists,
  knowledgeSnippets,
  phoneNumbers,
  receptionistProfiles,
  rlsContextStatement,
  unansweredQuestionReceptionists,
  users,
  type Database,
  type DatabaseTransaction,
} from "@lobbystack/db";

import { findCurrentWidgetChat, findWidgetConversationId, getOrCreateConversation, getOrCreateWidgetConversation, setAutomationState } from "./conversations";
import { backfillReceptionistRecords, listPhoneReceptionists } from "./receptionistRecords";
import { archiveReceptionistInTransaction, createReceptionistInTransaction, setReceptionistStatusInTransaction } from "./receptionists";
import { receiveInboundSms } from "./sms";
import { createBusiness } from "./tenancy";
import { answerUnansweredQuestion, listOpenUnansweredQuestions, recordUnansweredQuestion } from "./unansweredQuestions";
import { createVoiceFollowUpTask, getCallDetail, listCalls } from "./voice";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Receptionist record integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

async function rollbackTest(run: (tx: DatabaseTransaction) => Promise<void>) {
  const rollback = new Error("rollback test fixture");
  await expect(client!.db.transaction(async (tx) => {
    await run(tx);
    throw rollback;
  })).rejects.toBe(rollback);
}

async function as(tx: DatabaseTransaction, role: "lobbystack_app" | "lobbystack_worker" | null) {
  await tx.execute(sql`reset role`);
  if (role) await tx.execute(sql.raw(`set local role ${role}`));
}

/** Acts as the business's owner in the dashboard: the app role under the business's row level security. */
async function asOwner(tx: DatabaseTransaction, input: { userId: string; businessId: string }) {
  await as(tx, "lobbystack_app");
  await tx.execute(rlsContextStatement({ userId: input.userId, businessId: input.businessId, actorType: "operator" }));
}

/** Runs a step that should fail in a savepoint, so the transaction goes on after it. */
async function failure(tx: DatabaseTransaction, run: (inner: DatabaseTransaction) => Promise<unknown>): Promise<unknown> {
  return await tx.transaction(async (inner) => { await run(inner); }).then(() => null, (error: unknown) => error);
}

const phone = () => `+1604${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`;

/**
 * A Pro business, whose default receptionist is the front desk, with a second
 * receptionist for its Gastown store.
 */
async function seedChain(tx: DatabaseTransaction, name = "Kitsilano Coffee") {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, email: `${userId}@example.invalid`, normalizedEmail: `${userId}@example.invalid`, name: "Riley Owner" });
  await as(tx, "lobbystack_app");
  const context = { db: tx as unknown as Database };
  const { businessId } = await createBusiness(context, { userId, name, timezone: "America/Vancouver", businessType: "restaurant", deploymentMode: "cloud" });
  await as(tx, null);
  await tx.insert(billingAccounts).values({ businessId, billingKey: `business:${businessId}`, plan: "pro", subscriptionState: "active", source: "polar" });
  const [main] = await tx.select().from(receptionistProfiles).where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.isDefault, true)));
  await asOwner(tx, { userId, businessId });
  const store = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Gastown store", description: "Orders at Gastown" } });
  await as(tx, null);
  return { context, userId, businessId, mainId: main!.id, storeId: store.id };
}

/** Clears receptionist_id the way rows from before migration 0137 have it: the insert trigger fills every new row. */
async function fromBeforeReceptionists(tx: DatabaseTransaction, table: "calls" | "conversations" | "inbox_items" | "phone_numbers", businessId: string, receptionistId: string) {
  await tx.execute(sql`update ${sql.identifier(table)} set receptionist_id = null where business_id = ${businessId}::uuid and receptionist_id = ${receptionistId}::uuid`);
}

async function nullCount(tx: DatabaseTransaction, table: "calls" | "conversations" | "inbox_items", businessId: string) {
  const result = await tx.execute<{ count: number }>(sql`select count(*)::int as count from ${sql.identifier(table)} where business_id = ${businessId}::uuid and receptionist_id is null`);
  return Number(result.rows[0]?.count ?? 0);
}

const newCall = (businessId: string, receptionistId?: string) => ({ businessId, providerCallId: `call-${randomUUID()}`, transport: "sip", startedAt: new Date(), ...(receptionistId ? { receptionistId } : {}) });

describe.skipIf(!testUrl)("records naming their receptionist, against PostgreSQL under RLS", () => {
  it("gives old records the default receptionist in batches until a pass changes nothing, leaving named records and other businesses alone", async () => {
    await rollbackTest(async (tx) => {
      const { context, businessId, mainId, storeId } = await seedChain(tx);
      await tx.insert(calls).values(Array.from({ length: 5 }, () => newCall(businessId)));
      await tx.insert(calls).values(newCall(businessId, storeId));
      await tx.insert(conversations).values(Array.from({ length: 3 }, () => ({ businessId, channel: "web_chat" })));
      await tx.insert(conversations).values({ businessId, channel: "web_chat", receptionistId: storeId });
      await tx.insert(inboxItems).values({ businessId, kind: "callback", title: "Call back", body: "Asked for a call back." });
      for (const table of ["calls", "conversations", "inbox_items"] as const) await fromBeforeReceptionists(tx, table, businessId, mainId);
      const other = await seedChain(tx, "Other Roasters");
      await tx.insert(calls).values(Array.from({ length: 3 }, () => newCall(other.businessId)));
      await fromBeforeReceptionists(tx, "calls", other.businessId, other.mainId);

      await as(tx, "lobbystack_worker");
      const pauses: number[] = [];
      const result = await backfillReceptionistRecords(context, { businessId, batchSize: 2, pauseMs: 5, sleep: async (ms) => { pauses.push(ms); } });
      // Two of each a pass: 5 rows, then 3, then 1, then none.
      expect(result).toEqual({ filled: { calls: 5, conversations: 3, inbox_items: 1 }, passes: 4, finished: true });
      expect(pauses).toEqual([5, 5, 5]);

      await as(tx, null);
      for (const table of ["calls", "conversations", "inbox_items"] as const) expect(await nullCount(tx, table, businessId)).toBe(0);
      const callRows = await tx.select({ receptionistId: calls.receptionistId }).from(calls).where(eq(calls.businessId, businessId));
      expect(callRows.filter((row) => row.receptionistId === mainId)).toHaveLength(5);
      expect(callRows.filter((row) => row.receptionistId === storeId)).toHaveLength(1);
      const conversationRows = await tx.select({ receptionistId: conversations.receptionistId }).from(conversations).where(eq(conversations.businessId, businessId));
      expect(conversationRows.map((row) => row.receptionistId).sort()).toEqual([mainId, mainId, mainId, storeId].sort());
      // Another business's records wait for its own job.
      expect(await nullCount(tx, "calls", other.businessId)).toBe(3);

      // Once nothing is left, a run changes nothing.
      await as(tx, "lobbystack_worker");
      expect(await backfillReceptionistRecords(context, { businessId, pauseMs: 0 })).toEqual({ filled: { calls: 0, conversations: 0, inbox_items: 0 }, passes: 1, finished: true });
      // A run that reaches its limit says so, and the next one carries on.
      expect(await backfillReceptionistRecords(context, { businessId: other.businessId, batchSize: 1, pauseMs: 0, maxPasses: 2 })).toEqual({ filled: { calls: 2, conversations: 0, inbox_items: 0 }, passes: 2, finished: false });
      expect(await backfillReceptionistRecords(context, { businessId: other.businessId, pauseMs: 0 })).toMatchObject({ filled: { calls: 1 }, finished: true });
    });
  });

  it("leaves a business without a default receptionist as it is", async () => {
    await rollbackTest(async (tx) => {
      const businessId = randomUUID();
      await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "No profile yet", timezone: "UTC", businessType: "test" });
      await tx.insert(calls).values(newCall(businessId));
      await as(tx, "lobbystack_worker");
      await tx.execute(rlsContextStatement({ businessId, actorType: "worker" }));
      expect(await fillDefaultReceptionistBatch(tx, { table: "calls", businessId, limit: 10 })).toBe(0);
      await expect(fillDefaultReceptionistBatch(tx, { table: "contacts" as never, businessId, limit: 10 })).rejects.toThrow("Unknown record table");
      await as(tx, null);
      expect(await nullCount(tx, "calls", businessId)).toBe(1);
    });
  });

  it("skips a record a live transaction holds, so nothing waits on the backfill, and fills it on a later run", async () => {
    const businessId = randomUUID();
    const holder = await client!.pool.connect();
    try {
      await client!.db.insert(businesses).values({ id: businessId, slug: businessId, name: "Backfill lock test", timezone: "UTC", businessType: "test" });
      const [main] = await client!.db.insert(receptionistProfiles).values({ businessId, greeting: "Hello.", tone: "professional", summary: "Backfill lock test", bookingPolicy: "", transferMode: "never" }).returning({ id: receptionistProfiles.id });
      const rows = await client!.db.insert(calls).values([newCall(businessId), newCall(businessId)]).returning({ id: calls.id });
      await client!.db.execute(sql`update calls set receptionist_id = null where business_id = ${businessId}::uuid`);
      const held = rows[0]!.id;
      // A call in progress holds its row.
      await holder.query("begin");
      await holder.query("select id from calls where id = $1 for update", [held]);

      const first = await client!.db.transaction(async (tx) => {
        await as(tx, "lobbystack_worker");
        await tx.execute(rlsContextStatement({ businessId, actorType: "worker" }));
        return await fillDefaultReceptionistBatch(tx, { table: "calls", businessId, limit: 10 });
      });
      expect(first).toBe(1);
      const [heldRow] = await client!.db.select({ receptionistId: calls.receptionistId }).from(calls).where(eq(calls.id, held));
      expect(heldRow?.receptionistId).toBeNull();

      await holder.query("commit");
      expect(await backfillReceptionistRecords({ db: client!.db }, { businessId, pauseMs: 0 })).toMatchObject({ filled: { calls: 1 }, finished: true });
      const filled = await client!.db.select({ receptionistId: calls.receptionistId }).from(calls).where(eq(calls.businessId, businessId));
      expect(filled.map((row) => row.receptionistId)).toEqual([main!.id, main!.id]);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
      await client!.db.delete(businesses).where(eq(businesses.id, businessId));
    }
  });

  it("lists the receptionists that answer the business's numbers, a paused or archived one's as the default", async () => {
    await rollbackTest(async (tx) => {
      const { context, userId, businessId, mainId, storeId } = await seedChain(tx);
      await asOwner(tx, { userId, businessId });
      const lab = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Lab results" } });
      const catering = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Catering" } });
      const downtown = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Downtown" } });
      await setReceptionistStatusInTransaction(tx, { businessId, actorUserId: userId, receptionistId: lab.id, status: "paused" });
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: catering.id });
      await as(tx, null);
      const storeNumber = phone();
      const labNumber = phone();
      await tx.insert(phoneNumbers).values([
        { businessId, e164: storeNumber, receptionistId: storeId },
        { businessId, e164: labNumber, receptionistId: lab.id },
        { businessId, e164: phone(), receptionistId: catering.id },
        // Downtown's numbers take no calls.
        { businessId, e164: phone(), receptionistId: downtown.id, voiceEnabled: false },
        { businessId, e164: phone(), receptionistId: downtown.id, status: "released" },
      ]);

      await as(tx, "lobbystack_worker");
      expect((await listPhoneReceptionists(context, { businessId })).sort()).toEqual([mainId, storeId].sort());

      // The incoming call webhook asks the same before it knows the business.
      await as(tx, "lobbystack_app");
      const resolve = async (e164: string) => (await tx.execute<{ id: string | null }>(sql`select app.resolve_receptionist_by_phone(${e164}) as id`)).rows[0]?.id ?? null;
      expect(await resolve(storeNumber)).toBe(storeId);
      expect(await resolve(labNumber)).toBe(mainId);
      expect(await resolve(phone())).toBeNull();
      await as(tx, null);
      await fromBeforeReceptionists(tx, "phone_numbers", businessId, storeId);
      await as(tx, "lobbystack_app");
      // A number from before receptionists answers as the default.
      expect(await resolve(storeNumber)).toBe(mainId);
    });
  });

  it("filters calls by the receptionist that answered and names it, old calls counting for the default", async () => {
    await rollbackTest(async (tx) => {
      const { context, userId, businessId, mainId, storeId } = await seedChain(tx);
      const [old] = await tx.insert(calls).values(newCall(businessId)).returning({ id: calls.id });
      await fromBeforeReceptionists(tx, "calls", businessId, mainId);
      const [front] = await tx.insert(calls).values(newCall(businessId, mainId)).returning({ id: calls.id });
      const [store] = await tx.insert(calls).values(newCall(businessId, storeId)).returning({ id: calls.id });

      await as(tx, "lobbystack_app");
      const all = await listCalls(context, { userId, businessId });
      expect(all.pagination.total).toBe(3);
      const names = Object.fromEntries(all.calls.map((call) => [call.id as string, call.receptionist]));
      expect(names).toEqual({
        [old!.id]: { id: mainId, name: "Front desk" },
        [front!.id]: { id: mainId, name: "Front desk" },
        [store!.id]: { id: storeId, name: "Gastown store" },
      });
      const atFrontDesk = await listCalls(context, { userId, businessId, receptionistId: mainId });
      expect(atFrontDesk.calls.map((call) => call.id).sort()).toEqual([old!.id, front!.id].sort());
      expect(atFrontDesk.pagination.total).toBe(2);
      expect((await listCalls(context, { userId, businessId, receptionistId: storeId })).calls.map((call) => call.id)).toEqual([store!.id]);
      // Another business's receptionist answered none of them.
      expect((await listCalls(context, { userId, businessId, receptionistId: randomUUID() })).calls).toEqual([]);
      await expect(listCalls(context, { userId, businessId, receptionistId: "gastown" })).rejects.toMatchObject({ status: 400, code: "invalid_receptionist" });
      // A call's page names it too.
      expect((await getCallDetail(context, { userId, businessId, callId: store!.id }))?.call.receptionist).toEqual({ id: storeId, name: "Gastown store" });
      expect((await getCallDetail(context, { userId, businessId, callId: old!.id }))?.call.receptionist).toEqual({ id: mainId, name: "Front desk" });
    });
  });

  it("names the receptionist on a follow-up: the call's, or else the one that took it", async () => {
    await rollbackTest(async (tx) => {
      const { context, businessId, mainId, storeId } = await seedChain(tx);
      const [call] = await tx.insert(calls).values(newCall(businessId, storeId)).returning({ id: calls.id });
      await as(tx, "lobbystack_worker");
      // A follow-up saved after the call, whoever is answering then.
      const fromCall = await createVoiceFollowUpTask(context, { businessId, callId: call!.id, message: "Call me back about catering.", receptionistId: mainId });
      const fromChat = await createVoiceFollowUpTask(context, { businessId, message: "Call me back.", channel: "web_chat", receptionistId: storeId });
      const unnamed = await createVoiceFollowUpTask(context, { businessId, message: "Call me back.", receptionistId: "gastown" });
      await as(tx, null);
      const rows = await tx.select({ id: inboxItems.id, receptionistId: inboxItems.receptionistId }).from(inboxItems).where(eq(inboxItems.businessId, businessId));
      expect(Object.fromEntries(rows.map((row) => [row.id, row.receptionistId]))).toEqual({ [fromCall.inboxItemId]: storeId, [fromChat.inboxItemId]: storeId, [unnamed.inboxItemId]: mainId });
    });
  });

  it("names the receptionist a conversation starts with, keeps an open one's, and names a texted number's", async () => {
    await rollbackTest(async (tx) => {
      const { context, businessId, mainId, storeId } = await seedChain(tx);
      const storeNumber = phone();
      await tx.insert(phoneNumbers).values({ businessId, e164: storeNumber, receptionistId: storeId });
      await as(tx, "lobbystack_worker");
      const caller = phone();
      const first = await getOrCreateConversation(context, { businessId, contactPhone: caller, channel: "voice", receptionistId: storeId });
      const again = await getOrCreateConversation(context, { businessId, contactPhone: caller, channel: "voice", receptionistId: mainId });
      expect(again.conversationId).toBe(first.conversationId);
      const texter = phone();
      await receiveInboundSms(context, { businessId, providerMessageId: `SM${randomUUID()}`, from: texter, to: storeNumber, body: "Are you open today?", payload: {} });
      // A text to a number the business doesn't have, like the shared sender, is the default's.
      await receiveInboundSms(context, { businessId, providerMessageId: `SM${randomUUID()}`, from: phone(), to: phone(), body: "Hello?", payload: {} });
      await as(tx, null);
      const rows = await tx.select({ id: conversations.id, channel: conversations.channel, receptionistId: conversations.receptionistId }).from(conversations).where(eq(conversations.businessId, businessId));
      expect(rows.find((row) => row.id === first.conversationId)?.receptionistId).toBe(storeId);
      expect(rows.filter((row) => row.channel === "sms").map((row) => row.receptionistId).sort()).toEqual([mainId, storeId].sort());
    });
  });

  it("keeps a website visitor's chat with one receptionist, while a chat the team has stays theirs on any page", async () => {
    await rollbackTest(async (tx) => {
      const { context, userId, businessId, mainId, storeId } = await seedChain(tx);
      const widgetVisitorId = randomUUID();
      await as(tx, "lobbystack_worker");
      const first = await getOrCreateWidgetConversation(context, { businessId, widgetVisitorId, receptionistId: mainId });
      expect(first).toMatchObject({ automationState: "ai_active", receptionistId: mainId });
      expect(await getOrCreateWidgetConversation(context, { businessId, widgetVisitorId, receptionistId: mainId })).toEqual(first);

      // On the store's page the visitor's next message starts a chat with the store, and the first one closes.
      const second = await getOrCreateWidgetConversation(context, { businessId, widgetVisitorId, receptionistId: storeId });
      expect(second.conversationId).not.toBe(first.conversationId);
      expect(second).toMatchObject({ automationState: "ai_active", receptionistId: storeId });
      await as(tx, null);
      const [closed] = await tx.select({ status: conversations.status }).from(conversations).where(eq(conversations.id, first.conversationId));
      expect(closed?.status).toBe("closed");

      // Each page shows only its own receptionist's chat; a page naming none shows the open one.
      await as(tx, "lobbystack_worker");
      expect(await findCurrentWidgetChat(context, { businessId, widgetVisitorId, receptionistId: mainId })).toBeNull();
      expect(await findCurrentWidgetChat(context, { businessId, widgetVisitorId, receptionistId: storeId })).toEqual({ conversationId: second.conversationId, idle: false });
      expect(await findWidgetConversationId(context, { businessId, widgetVisitorId, receptionistId: mainId })).toBeNull();
      expect(await findWidgetConversationId(context, { businessId, widgetVisitorId, receptionistId: storeId })).toBe(second.conversationId);
      expect(await findWidgetConversationId(context, { businessId, widgetVisitorId })).toBe(second.conversationId);

      // Once someone from the team takes the store's chat, it stays the visitor's on the front desk's page too.
      await as(tx, "lobbystack_app");
      await setAutomationState(context, { userId, businessId, conversationId: second.conversationId, state: "human_handoff" });
      await as(tx, "lobbystack_worker");
      expect(await getOrCreateWidgetConversation(context, { businessId, widgetVisitorId, receptionistId: mainId })).toEqual({ conversationId: second.conversationId, automationState: "human_handoff", receptionistId: storeId });
      expect(await findCurrentWidgetChat(context, { businessId, widgetVisitorId, receptionistId: mainId })).toEqual({ conversationId: second.conversationId, idle: false });
    });
  });

  it("lets the receptionist answering now carry on a website chat from before receptionists", async () => {
    await rollbackTest(async (tx) => {
      const { context, businessId, mainId, storeId } = await seedChain(tx);
      const widgetVisitorId = randomUUID();
      await as(tx, "lobbystack_worker");
      const old = await getOrCreateWidgetConversation(context, { businessId, widgetVisitorId });
      // Named by the insert trigger, then cleared as the migration left older chats.
      expect(old.receptionistId).toBe(mainId);
      await as(tx, null);
      await fromBeforeReceptionists(tx, "conversations", businessId, mainId);

      await as(tx, "lobbystack_worker");
      expect(await findCurrentWidgetChat(context, { businessId, widgetVisitorId, receptionistId: storeId })).toEqual({ conversationId: old.conversationId, idle: false });
      expect(await getOrCreateWidgetConversation(context, { businessId, widgetVisitorId, receptionistId: storeId })).toEqual({ conversationId: old.conversationId, automationState: "ai_active", receptionistId: storeId });
      await as(tx, null);
      const [row] = await tx.select({ receptionistId: conversations.receptionistId }).from(conversations).where(eq(conversations.id, old.conversationId));
      expect(row?.receptionistId).toBe(storeId);
    });
  });

  it("counts a question under each receptionist that heard it, and filters the list by one", async () => {
    await rollbackTest(async (tx) => {
      const { context, userId, businessId, mainId, storeId } = await seedChain(tx);
      const [storeCall] = await tx.insert(calls).values(newCall(businessId, storeId)).returning({ id: calls.id });
      const [storeChat] = await tx.insert(conversations).values({ businessId, channel: "web_chat", receptionistId: storeId }).returning({ id: conversations.id });

      await as(tx, "lobbystack_worker");
      const now = new Date();
      // The store hears it on a call and in a chat; the front desk once, on a call naming nothing.
      const fromCall = await recordUnansweredQuestion(context, { businessId, question: "Do you sell gift cards?", channel: "voice", callId: storeCall!.id, now: new Date(now.getTime() - 60_000) });
      await recordUnansweredQuestion(context, { businessId, question: "do you sell GIFT cards", channel: "web_chat", conversationId: storeChat!.id, receptionistId: mainId, now });
      await recordUnansweredQuestion(context, { businessId, question: "Do you sell gift cards?", channel: "voice", now });
      // Only the front desk hears this one, named by the agent.
      const parking = await recordUnansweredQuestion(context, { businessId, question: "Is there parking?", channel: "web_chat", receptionistId: mainId, now });
      // A receptionist of another business never counts.
      await recordUnansweredQuestion(context, { businessId, question: "Is there parking?", channel: "web_chat", receptionistId: randomUUID(), now });

      await as(tx, null);
      const links = await tx.select().from(unansweredQuestionReceptionists).where(eq(unansweredQuestionReceptionists.businessId, businessId));
      expect(links.map((link) => [link.questionId === fromCall!.id ? "gift cards" : "parking", link.receptionistId === storeId ? "store" : "front desk", link.timesAsked]).sort()).toEqual([
        ["gift cards", "front desk", 1],
        ["gift cards", "store", 2],
        ["parking", "front desk", 2],
      ]);

      await as(tx, "lobbystack_app");
      const all = await listOpenUnansweredQuestions(context, { userId, businessId });
      expect(all.openCount).toBe(2);
      expect(all.openByReceptionist).toEqual({ [mainId]: 2, [storeId]: 1 });
      const giftCards = all.questions.find((question) => question.id === fromCall!.id)!;
      expect(giftCards.timesAsked).toBe(3);
      expect(giftCards.askedOf.map((asker) => [asker.name, asker.timesAsked, asker.archived])).toEqual([["Gastown store", 2, false], ["Front desk", 1, false]]);
      const atStore = await listOpenUnansweredQuestions(context, { userId, businessId, receptionistId: storeId });
      expect(atStore.questions.map((question) => question.id)).toEqual([fromCall!.id]);
      expect(atStore.openCount).toBe(1);
      expect((await listOpenUnansweredQuestions(context, { userId, businessId, receptionistId: mainId })).questions.map((question) => question.id).sort()).toEqual([fromCall!.id, parking!.id].sort());
      await expect(listOpenUnansweredQuestions(context, { userId, businessId, receptionistId: "store" })).rejects.toMatchObject({ status: 400, code: "invalid_receptionist" });

      // A question from before receptionists, with no rows for who asked, was the default's.
      await as(tx, null);
      await tx.delete(unansweredQuestionReceptionists).where(eq(unansweredQuestionReceptionists.questionId, parking!.id));
      await as(tx, "lobbystack_app");
      const withOld = await listOpenUnansweredQuestions(context, { userId, businessId, receptionistId: mainId });
      expect(withOld.questions.find((question) => question.id === parking!.id)?.askedOf).toEqual([expect.objectContaining({ receptionistId: mainId, name: "Front desk", timesAsked: 2 })]);
      expect((await listOpenUnansweredQuestions(context, { userId, businessId, receptionistId: storeId })).questions.map((question) => question.id)).toEqual([fromCall!.id]);
    });
  });

  it("answers a question for the receptionists that asked, for everyone, or for those chosen", async () => {
    await rollbackTest(async (tx) => {
      const { context, userId, businessId, mainId, storeId } = await seedChain(tx);
      await asOwner(tx, { userId, businessId });
      const catering = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Catering" } });

      await as(tx, "lobbystack_worker");
      const ask = async (question: string, ...receptionistIds: string[]) => {
        let saved: Awaited<ReturnType<typeof recordUnansweredQuestion>> = null;
        for (const receptionistId of receptionistIds) saved = await recordUnansweredQuestion(context, { businessId, question, channel: "web_chat", receptionistId });
        return saved!;
      };
      const giftCards = await ask("Do you sell gift cards?", storeId, catering.id);
      const parking = await ask("Is there parking?", storeId);
      const wifi = await ask("Do you have wifi?", catering.id);
      const dogs = await ask("Can I bring my dog?", mainId);

      await asOwner(tx, { userId, businessId });
      const asked = await answerUnansweredQuestion(context, { userId, businessId, questionId: giftCards.id, answer: "Yes, at the counter.", audience: { audience: "asked" } });
      expect(asked.audience).toBe("chosen");
      expect([...asked.receptionistIds].sort()).toEqual([storeId, catering.id].sort());
      const everyone = await answerUnansweredQuestion(context, { userId, businessId, questionId: parking.id, answer: "Street parking only.", audience: { audience: "everyone" } });
      expect(everyone).toEqual({ snippetId: everyone.snippetId, audience: "everyone", receptionistIds: [] });
      const chosen = await answerUnansweredQuestion(context, { userId, businessId, questionId: dogs.id, answer: "Dogs are welcome on the patio.", audience: { audience: "chosen", receptionistIds: [mainId, storeId] } });
      expect(chosen.receptionistIds).toEqual([mainId, storeId]);

      // Every receptionist that asked is archived: the answer needs someone chosen.
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: catering.id });
      const refused = await failure(tx, (inner) => answerUnansweredQuestion({ db: inner as unknown as Database }, { userId, businessId, questionId: wifi.id, answer: "Yes, ask for the password.", audience: { audience: "asked" } }));
      expect(refused).toMatchObject({ status: 409, code: "no_receptionists_asked" });

      await as(tx, null);
      const audiences = Object.fromEntries((await tx.select({ id: knowledgeSnippets.id, audience: knowledgeSnippets.audience }).from(knowledgeSnippets).where(eq(knowledgeSnippets.businessId, businessId))).map((row) => [row.id, row.audience]));
      expect(audiences).toEqual({ [asked.snippetId]: "chosen", [everyone.snippetId]: "everyone", [chosen.snippetId]: "chosen" });
      const linked = await tx.select({ snippetId: knowledgeSnippetReceptionists.snippetId, receptionistId: knowledgeSnippetReceptionists.receptionistId }).from(knowledgeSnippetReceptionists).where(eq(knowledgeSnippetReceptionists.businessId, businessId));
      expect(linked.filter((row) => row.snippetId === asked.snippetId).map((row) => row.receptionistId).sort()).toEqual([storeId, catering.id].sort());
      expect(linked.filter((row) => row.snippetId === chosen.snippetId).map((row) => row.receptionistId).sort()).toEqual([mainId, storeId].sort());
      expect(linked.filter((row) => row.snippetId === everyone.snippetId)).toEqual([]);
    });
  });

  it("reports the migrate service's receptionist checks: shared settings that differ, a missing default, records left to fill", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, mainId } = await seedChain(tx);
      const bare = randomUUID();
      await tx.insert(businesses).values({ id: bare, slug: bare, name: "No profile yet", timezone: "UTC", businessType: "test" });
      await tx.insert(calls).values(newCall(businessId));
      await fromBeforeReceptionists(tx, "calls", businessId, mainId);

      const before = await checkReceptionistData(tx);
      expect(before.mismatchedSharedSettings).not.toContain(businessId);
      expect(before.withoutDefault).toContain(bare);
      expect(before.withoutDefault).not.toContain(businessId);
      expect(before.unfilled.calls).toBeGreaterThanOrEqual(1);

      // A write that reached only one side.
      await tx.execute(sql`update businesses set recording_notice = not recording_notice where id = ${businessId}::uuid`);
      expect((await checkReceptionistData(tx)).mismatchedSharedSettings).toContain(businessId);
      await tx.update(receptionistProfiles).set({ recordingNotice: sql`not ${receptionistProfiles.recordingNotice}` }).where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.isDefault, true)));
      // The default's write is copied to the business, so both sides agree again.
      expect((await checkReceptionistData(tx)).mismatchedSharedSettings).not.toContain(businessId);
      await tx.execute(sql`update businesses set summary_fingerprint = 'stale' where id = ${businessId}::uuid`);
      expect((await checkReceptionistData(tx)).mismatchedSharedSettings).toContain(businessId);
      expect((await tx.select({ id: calls.id }).from(calls).where(and(eq(calls.businessId, businessId), isNull(calls.receptionistId))))).toHaveLength(1);
    });
  });
});
